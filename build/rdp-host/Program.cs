// rdp-host: hosts the Microsoft RDP ActiveX control (mstscax.dll) in a
// borderless WinForms window so Server Session Manager can overlay it into a
// tab. Unlike embedding mstsc.exe, the control renegotiates the remote
// resolution live on resize (UpdateSessionDisplaySettings) and reports
// connect/disconnect directly, with no credential staging through cmdkey.
//
// Speaks line-delimited JSON over stdio:
//   in : {"host":"...","port":3389,"username":"","password":"","width":1600,
//         "height":900,"drives":false,"printers":false,"admin":false}
//   in : {"cmd":"disconnect"}
//   out: {"event":"hwnd","hwnd":123456}
//   out: {"event":"connected"}
//   out: {"event":"disconnected"}
//   out: {"event":"fatal","message":"..."}
//
// Build: npm run build:host (uses the .NET Framework csc.exe that ships with
// Windows; targets C# 5, so no modern syntax here).
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
using System.Web.Script.Serialization;

namespace SsmRdpHost
{
    static class Program
    {
        static readonly object OutLock = new object();

        public static void Emit(string json)
        {
            lock (OutLock)
            {
                Console.Out.WriteLine(json);
                Console.Out.Flush();
            }
        }

        public static string JsonEscape(string s)
        {
            if (s == null) return "";
            return s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "\\r").Replace("\n", "\\n");
        }

        public static void Try(Action a)
        {
            try { a(); }
            catch (Exception) { /* optional setting not supported by this control version */ }
        }

        [DllImport("user32.dll", SetLastError = true)]
        static extern bool SetProcessDpiAwarenessContext(IntPtr value);
        [DllImport("user32.dll")]
        static extern bool SetProcessDPIAware();

        [STAThread]
        static int Main()
        {
            // Per-monitor-v2 DPI awareness so all window sizes are physical
            // pixels and the negotiated resolution matches what the app asked
            // for. Falls back for pre-1703 Windows 10.
            try
            {
                if (!SetProcessDpiAwarenessContext((IntPtr)(-4))) SetProcessDPIAware();
            }
            catch (Exception)
            {
                Try(() => SetProcessDPIAware());
            }

            string line = Console.In.ReadLine();
            if (string.IsNullOrEmpty(line)) return 1;
            Dictionary<string, object> cfg;
            try
            {
                cfg = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(line);
            }
            catch (Exception ex)
            {
                Emit("{\"event\":\"fatal\",\"message\":\"bad config: " + JsonEscape(ex.Message) + "\"}");
                return 1;
            }

            Application.EnableVisualStyles();
            // Watchdog: mstscax's COM initialisation intermittently hangs
            // (seen on Windows 11 even for a plain CoCreateInstance). Report
            // fatal and die so the app can retry with a fresh process or fall
            // back to mstsc, instead of waiting on a silent one.
            Thread watchdog = new Thread(delegate ()
            {
                Thread.Sleep(15000);
                if (!HostForm.Announced)
                {
                    Emit("{\"event\":\"fatal\",\"message\":\"startup watchdog: control creation hung\"}");
                    Environment.Exit(3);
                }
            });
            watchdog.IsBackground = true;
            watchdog.Start();

            // Probe before any UI exists: fails (or hangs into the watchdog)
            // in the simplest possible context, and tells us the CLSID works.
            string clsid;
            try
            {
                Emit("{\"event\":\"debug\",\"message\":\"probing for RDP control\"}");
                clsid = HostForm.ProbeClsid();
                Emit("{\"event\":\"debug\",\"message\":\"using control clsid " + clsid + "\"}");
            }
            catch (Exception ex)
            {
                Emit("{\"event\":\"fatal\",\"message\":\"" + JsonEscape(ex.Message) + "\"}");
                return 1;
            }

            try
            {
                Application.Run(new HostForm(cfg, clsid));
            }
            catch (Exception ex)
            {
                Emit("{\"event\":\"fatal\",\"message\":\"" + JsonEscape(ex.Message) + "\"}");
                return 1;
            }
            return 0;
        }
    }

    // AxHost's constructor is protected; a trivial subclass pins the CLSID.
    // Hosting via AxHost avoids needing aximp-generated interop assemblies:
    // everything on the control is called through IDispatch (dynamic).
    class RdpAx : AxHost
    {
        public RdpAx(string clsid) : base(clsid) { }
        public object Ocx { get { return GetOcx(); } }
    }

    class HostForm : Form
    {
        // Set once the hwnd event has been emitted; read by the watchdog.
        public static volatile bool Announced;

        // MsRdpClient*NotSafeForScripting coclass CLSIDs from the MSTSCLib
        // type library, newest first. The NotSafeForScripting variants are
        // REQUIRED: the plain coclasses silently refuse ClearTextPassword, so
        // the user gets a credential prompt despite a saved password. (Do not
        // trust the registry friendly names: the "(redistributable)" entries
        // are the plain safe-for-scripting classes, not these.) MsRdpClient8+
        // all support UpdateSessionDisplaySettings (live resolution change).
        static readonly string[] CandidateClsids =
        {
            "3f859aa3-c2d4-4faa-b0e4-fd0c9c4e5e3a", // MsRdpClient12NotSafeForScripting
            "1df7c823-b2d4-4b54-975a-f2ac5d7cf8b8", // MsRdpClient11NotSafeForScripting
            "a0c63c30-f08d-4ab4-907c-34905d770c7d", // MsRdpClient10NotSafeForScripting
            "8b918b82-7985-4c24-89df-c33ad2bbfbcd", // MsRdpClient9NotSafeForScripting
            "a3bc03a0-041d-42e3-ad22-882b7865c9c5", // MsRdpClient8NotSafeForScripting
        };

        readonly Dictionary<string, object> cfg;
        readonly string clsid;
        RdpAx ax;
        dynamic ocx;
        System.Windows.Forms.Timer statePoll;
        System.Windows.Forms.Timer resizeSettle;
        int lastState = -1;
        bool everConnected;
        int sentW, sentH;

        public HostForm(Dictionary<string, object> config, string controlClsid)
        {
            cfg = config;
            clsid = controlClsid;
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.Manual;
            BackColor = ColorTranslator.FromHtml("#1a1d23");
            AutoScaleMode = AutoScaleMode.None;
            int w = GetInt("width", 1600), h = GetInt("height", 900);
            // Created offscreen; the app overlays it onto the tab as soon as
            // it receives the hwnd event.
            Bounds = new Rectangle(-32000, -32000, w, h);
            ClientSize = new Size(w, h);
        }

        // Never steal focus from the app when first shown.
        protected override bool ShowWithoutActivation
        {
            get { return true; }
        }

        int GetInt(string key, int fallback)
        {
            object v;
            if (!cfg.TryGetValue(key, out v) || v == null) return fallback;
            try { return Convert.ToInt32(v); }
            catch (Exception) { return fallback; }
        }

        string GetStr(string key)
        {
            object v;
            if (!cfg.TryGetValue(key, out v) || v == null) return "";
            return v.ToString();
        }

        bool GetBool(string key)
        {
            object v;
            if (!cfg.TryGetValue(key, out v) || v == null) return false;
            try { return Convert.ToBoolean(v); }
            catch (Exception) { return false; }
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            // Create the control BEFORE announcing the hwnd: the app treats
            // "fatal before hwnd" as the signal to fall back to mstsc
            // embedding. Connect() itself is asynchronous, so this is quick.
            try
            {
                CreateRdp();
            }
            catch (Exception ex)
            {
                Program.Emit("{\"event\":\"fatal\",\"message\":\"" + Program.JsonEscape(ex.Message) + "\"}");
                Application.Exit();
                return;
            }
            Program.Emit("{\"event\":\"hwnd\",\"hwnd\":" + Handle.ToInt64() + "}");
            Announced = true;
            Thread stdin = new Thread(StdinLoop);
            stdin.IsBackground = true;
            stdin.Start();
        }

        // A CLSID can be registered yet not be creatable (e.g. version 13 on
        // Windows 11), and a bad CLSID can make AxHost hang rather than throw.
        // So probe with a plain CoCreateInstance first, which fails fast, and
        // only give AxHost a CLSID that is known to instantiate.
        public static string ProbeClsid()
        {
            Exception last = null;
            foreach (string candidate in CandidateClsids)
            {
                try
                {
                    Type t = Type.GetTypeFromCLSID(new Guid(candidate));
                    object o = Activator.CreateInstance(t);
                    Marshal.ReleaseComObject(o);
                    return candidate;
                }
                catch (Exception ex)
                {
                    last = ex;
                }
            }
            throw new Exception("no usable Microsoft RDP client control: " + (last == null ? "none registered" : last.Message));
        }

        void CreateAx()
        {
            Program.Emit("{\"event\":\"debug\",\"message\":\"creating ax host\"}");
            ax = new RdpAx(clsid);
            ((ISupportInitialize)ax).BeginInit();
            ax.Dock = DockStyle.Fill;
            Controls.Add(ax);
            ((ISupportInitialize)ax).EndInit();
            ax.CreateControl();
            if (ax.Ocx == null) throw new Exception("control created but OCX is null");
        }

        void CreateRdp()
        {
            CreateAx();
            Program.Emit("{\"event\":\"debug\",\"message\":\"ax host created\"}");
            ocx = ax.Ocx;

            ocx.Server = GetStr("host");
            string user = GetStr("username");
            if (user.Length > 0) ocx.UserName = user;
            int w = GetInt("width", ClientSize.Width), h = GetInt("height", ClientSize.Height);
            ocx.DesktopWidth = w;
            ocx.DesktopHeight = h;
            sentW = w;
            sentH = h;
            Program.Try(() => { ocx.ColorDepth = 32; });

            dynamic adv = null;
            try { adv = ocx.AdvancedSettings9; }
            catch (Exception) { }
            if (adv == null)
            {
                try { adv = ocx.AdvancedSettings7; }
                catch (Exception) { }
            }
            if (adv == null) adv = ocx.AdvancedSettings2;
            dynamic advSet = adv;

            Program.Try(() => { advSet.RDPPort = GetInt("port", 3389); });
            Program.Try(() => { advSet.EnableCredSspSupport = true; });
            string pw = GetStr("password");
            if (pw.Length > 0)
            {
                // Never swallow this silently: a failed put here is exactly
                // the "credential prompt despite saved password" bug.
                try
                {
                    advSet.ClearTextPassword = pw;
                }
                catch (Exception ex)
                {
                    Program.Emit("{\"event\":\"debug\",\"message\":\"ClearTextPassword failed: " + Program.JsonEscape(ex.Message) + "\"}");
                }
            }
            // Scale the bitmap while the user is mid-resize; once the resize
            // settles the true resolution is renegotiated below, after which
            // the scale factor is 1:1 again.
            Program.Try(() => { advSet.SmartSizing = true; });
            Program.Try(() => { advSet.AuthenticationLevel = 2; });
            Program.Try(() => { advSet.RedirectClipboard = true; });
            Program.Try(() => { advSet.RedirectDrives = GetBool("drives"); });
            Program.Try(() => { advSet.RedirectPrinters = GetBool("printers"); });
            Program.Try(() => { advSet.ConnectToAdministerServer = GetBool("admin"); });
            Program.Try(() => { advSet.EnableAutoReconnect = true; });
            Program.Try(() => { advSet.GrabFocusOnConnect = false; });

            Program.Emit("{\"event\":\"debug\",\"message\":\"connecting\"}");
            ocx.Connect();

            statePoll = new System.Windows.Forms.Timer();
            statePoll.Interval = 250;
            statePoll.Tick += PollState;
            statePoll.Start();

            resizeSettle = new System.Windows.Forms.Timer();
            resizeSettle.Interval = 400;
            resizeSettle.Tick += SettleResize;
        }

        // The control exposes Connected: 0 = disconnected, 1 = connected,
        // 2 = connecting. Polling avoids needing COM connection-point event
        // plumbing, which AxHost does not wire up without interop assemblies.
        void PollState(object sender, EventArgs e)
        {
            int state;
            try { state = (int)ocx.Connected; }
            catch (Exception) { state = 0; }
            if (state == lastState) return;
            int prev = lastState;
            lastState = state;
            if (state == 1)
            {
                everConnected = true;
                Program.Emit("{\"event\":\"connected\"}");
            }
            else if (state == 0 && (prev == 1 || prev == 2))
            {
                Program.Emit("{\"event\":\"disconnected\"}");
                Application.Exit();
            }
        }

        protected override void OnResize(EventArgs e)
        {
            base.OnResize(e);
            if (resizeSettle != null && everConnected)
            {
                resizeSettle.Stop();
                resizeSettle.Start();
            }
        }

        // Live resolution renegotiation once a resize settles. Falls back to
        // the control's quick Reconnect(w, h) if the server predates RDP 8.1
        // display-update support.
        void SettleResize(object sender, EventArgs e)
        {
            resizeSettle.Stop();
            if (lastState != 1) return;
            int w = ClientSize.Width, h = ClientSize.Height;
            if (w < 200 || h < 150) return;
            if (w == sentW && h == sentH) return;
            sentW = w;
            sentH = h;
            try
            {
                ocx.UpdateSessionDisplaySettings((uint)w, (uint)h, (uint)w, (uint)h, 0u, 100u, 100u);
            }
            catch (Exception)
            {
                Program.Try(() => ocx.Reconnect((uint)w, (uint)h));
            }
        }

        void StdinLoop()
        {
            string line;
            while ((line = Console.In.ReadLine()) != null)
            {
                if (line.Contains("\"disconnect\""))
                {
                    try { BeginInvoke((Action)DoDisconnect); }
                    catch (Exception) { }
                }
            }
            // stdin EOF: the app is gone; take the session down with us.
            try { BeginInvoke((Action)Application.Exit); }
            catch (Exception) { }
        }

        void DoDisconnect()
        {
            try
            {
                if ((int)ocx.Connected != 0)
                {
                    ocx.Disconnect(); // poll sees 0, emits disconnected, exits
                    return;
                }
            }
            catch (Exception) { }
            Application.Exit();
        }
    }
}
