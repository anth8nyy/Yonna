# Yonna on the Windows PC: hold Left Ctrl, talk, let go — as fn on the Mac.
#
# Runs from sign-in (the scheduled task "Yonna Talk"), unseen until used.
# Left Ctrl held on its own for a moment starts listening — Ctrl+C and other
# shortcuts never do, nor does it while a game is in front (Ctrl is crouch).
# What's said is recorded from the Logitech C270's microphone and sent, with
# a picture of the screen (and of the camera, while its window is open), to
# the Mac's Yonna over the home network: her https port, pinned to her
# certificate, with this PC's own key. Her answer shows in a box like the
# Mac's, top left, and is spoken here. Let go without a word and nothing
# happens; press again while she speaks and she stops and listens.
# "Take a look at my desk" opens a small camera window; "close the camera"
# closes it. Installed by scripts/pc/install.mjs, which fills in the
# address, key and certificate print.

$Mac = '__MAC__'
$Key = '__KEY__'
$Print = '__PRINT__'

Add-Type -AssemblyName System.Windows.Forms, System.Drawing, System.Web.Extensions
$code = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Media;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

// Recording with Windows' own wave API: 16 kHz, 16-bit, mono, from the
// microphone whose name says Logi/C270 (or the default one).
public class Mic {
  [StructLayout(LayoutKind.Sequential)] struct WAVEFORMATEX { public ushort wFormatTag, nChannels; public uint nSamplesPerSec, nAvgBytesPerSec; public ushort nBlockAlign, wBitsPerSample, cbSize; }
  [StructLayout(LayoutKind.Sequential)] struct WAVEHDR { public IntPtr lpData; public uint dwBufferLength, dwBytesRecorded; public IntPtr dwUser; public uint dwFlags, dwLoops; public IntPtr lpNext, reserved; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct WAVEINCAPS { public ushort wMid, wPid; public uint vDriverVersion; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szPname; public uint dwFormats; public ushort wChannels, wReserved1; }
  [DllImport("winmm.dll")] static extern uint waveInGetNumDevs();
  [DllImport("winmm.dll", CharSet = CharSet.Unicode)] static extern int waveInGetDevCapsW(UIntPtr id, ref WAVEINCAPS caps, int size);
  [DllImport("winmm.dll")] static extern int waveInOpen(out IntPtr h, uint id, ref WAVEFORMATEX f, IntPtr cb, IntPtr inst, uint flags);
  [DllImport("winmm.dll")] static extern int waveInPrepareHeader(IntPtr h, IntPtr hdr, int size);
  [DllImport("winmm.dll")] static extern int waveInUnprepareHeader(IntPtr h, IntPtr hdr, int size);
  [DllImport("winmm.dll")] static extern int waveInAddBuffer(IntPtr h, IntPtr hdr, int size);
  [DllImport("winmm.dll")] static extern int waveInStart(IntPtr h);
  [DllImport("winmm.dll")] static extern int waveInStop(IntPtr h);
  [DllImport("winmm.dll")] static extern int waveInReset(IntPtr h);
  [DllImport("winmm.dll")] static extern int waveInClose(IntPtr h);
  const uint WHDR_DONE = 1, BYTES = 3200; const int N = 10;
  IntPtr h = IntPtr.Zero; IntPtr[] hdrs = new IntPtr[N]; MemoryStream pcm; System.Threading.Timer poll; readonly object gate = new object();
  public volatile float Level;
  public int Loud; // how many moments were loud enough to be speech
  int Hsize { get { return Marshal.SizeOf(typeof(WAVEHDR)); } }

  static uint Pick() {
    uint n = waveInGetNumDevs();
    for (uint i = 0; i < n; i++) {
      var c = new WAVEINCAPS();
      if (waveInGetDevCapsW(new UIntPtr(i), ref c, Marshal.SizeOf(c)) == 0 && c.szPname != null &&
          (c.szPname.IndexOf("C270", StringComparison.OrdinalIgnoreCase) >= 0 || c.szPname.IndexOf("Logi", StringComparison.OrdinalIgnoreCase) >= 0)) return i;
    }
    return 0xFFFFFFFF; // the default microphone
  }

  public bool Start() {
    var f = new WAVEFORMATEX { wFormatTag = 1, nChannels = 1, nSamplesPerSec = 16000, nAvgBytesPerSec = 32000, nBlockAlign = 2, wBitsPerSample = 16, cbSize = 0 };
    if (waveInOpen(out h, Pick(), ref f, IntPtr.Zero, IntPtr.Zero, 0) != 0) { h = IntPtr.Zero; return false; }
    pcm = new MemoryStream();
    for (int i = 0; i < N; i++) {
      var hd = new WAVEHDR { lpData = Marshal.AllocHGlobal((int)BYTES), dwBufferLength = BYTES };
      hdrs[i] = Marshal.AllocHGlobal(Hsize);
      Marshal.StructureToPtr(hd, hdrs[i], false);
      waveInPrepareHeader(h, hdrs[i], Hsize);
      waveInAddBuffer(h, hdrs[i], Hsize);
    }
    waveInStart(h);
    poll = new System.Threading.Timer(_ => Drain(true), null, 20, 20);
    return true;
  }

  void Drain(bool again) {
    lock (gate) {
      if (h == IntPtr.Zero) return;
      foreach (var p in hdrs) {
        var hd = (WAVEHDR)Marshal.PtrToStructure(p, typeof(WAVEHDR));
        if ((hd.dwFlags & WHDR_DONE) == 0) continue;
        var buf = new byte[hd.dwBytesRecorded];
        Marshal.Copy(hd.lpData, buf, 0, buf.Length);
        pcm.Write(buf, 0, buf.Length);
        double sum = 0; int n = 0;
        for (int i = 0; i + 1 < buf.Length; i += 4) { double v = BitConverter.ToInt16(buf, i) / 32768.0; sum += v * v; n++; }
        Level = (float)Math.Min(1, Math.Sqrt(sum / Math.Max(1, n)) * 12);
        if (Level > 0.18f) Loud++;
        waveInUnprepareHeader(h, p, Hsize);
        if (again) {
          hd.dwFlags = 0; hd.dwBytesRecorded = 0;
          Marshal.StructureToPtr(hd, p, false);
          waveInPrepareHeader(h, p, Hsize);
          waveInAddBuffer(h, p, Hsize);
        }
      }
    }
  }

  // Stops, and gives back what was said as a WAV file's bytes.
  public byte[] Stop() {
    if (h == IntPtr.Zero) return new byte[0];
    if (poll != null) poll.Dispose();
    Thread.Sleep(150); // the last moment of speech
    waveInStop(h); waveInReset(h);
    Thread.Sleep(50);
    Drain(false);
    lock (gate) {
      foreach (var p in hdrs) {
        var hd = (WAVEHDR)Marshal.PtrToStructure(p, typeof(WAVEHDR));
        waveInUnprepareHeader(h, p, Hsize);
        Marshal.FreeHGlobal(hd.lpData); Marshal.FreeHGlobal(p);
      }
      waveInClose(h); h = IntPtr.Zero;
    }
    Level = 0;
    var data = pcm.ToArray();
    var o = new MemoryStream();
    var w = new BinaryWriter(o);
    w.Write(Encoding.ASCII.GetBytes("RIFF")); w.Write(36 + data.Length); w.Write(Encoding.ASCII.GetBytes("WAVEfmt "));
    w.Write(16); w.Write((short)1); w.Write((short)1); w.Write(16000); w.Write(32000); w.Write((short)2); w.Write((short)16);
    w.Write(Encoding.ASCII.GetBytes("data")); w.Write(data.Length); w.Write(data);
    return o.ToArray();
  }
}

// A window that shows up on top without taking the keyboard from what you're doing.
public class Quiet : Form {
  [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr h, int a, ref int v, int s);
  protected override bool ShowWithoutActivation { get { return true; } }
  protected override CreateParams CreateParams { get { var p = base.CreateParams; p.ExStyle |= 0x08000000 | 0x80 | 0x8; return p; } }
  protected override void OnHandleCreated(EventArgs e) {
    base.OnHandleCreated(e);
    int round = 2; DwmSetWindowAttribute(Handle, 33, ref round, 4);
    int dark = 1; DwmSetWindowAttribute(Handle, 20, ref dark, 4);
  }
  public Quiet() { FormBorderStyle = FormBorderStyle.None; ShowInTaskbar = false; TopMost = true; StartPosition = FormStartPosition.Manual; }
}

// Yonna's box, as on the Mac: top left, a small orb, Listening / Thinking,
// the voice's wave, then what was heard and her answer.
public class Box : Quiet {
  public string State = "answer", Q = "", A = "";
  public Func<float> Level = () => 0;
  System.Windows.Forms.Timer anim = new System.Windows.Forms.Timer(), hideTimer = new System.Windows.Forms.Timer();
  Font status = new Font("Segoe UI", 9f, FontStyle.Regular), qf = new Font("Segoe UI", 9.75f), af = new Font("Segoe UI", 11.25f);
  float t, wave;
  const int W = 380, Pad = 14, Text0 = 52;
  public Box() {
    BackColor = Color.FromArgb(28, 28, 31); Opacity = 0.96; DoubleBuffered = true; Size = new Size(W, 54);
    anim.Interval = 33; anim.Tick += (s, e) => { t += 0.033f; wave += (Level() - wave) * 0.35f; Invalidate(); };
    hideTimer.Tick += (s, e) => { hideTimer.Stop(); anim.Stop(); Hide(); };
  }
  public void Set(string state, string q, string a, int hideAfterMs) {
    if (InvokeRequired) { BeginInvoke(new Action(() => Set(state, q, a, hideAfterMs))); return; }
    State = state; Q = q ?? ""; A = a ?? "";
    int h = 54;
    if (Q.Length > 0) h += TextRenderer.MeasureText(Q, qf, new Size(W - 2 * Pad, 1000), TextFormatFlags.WordBreak).Height + 2;
    if (A.Length > 0) h += TextRenderer.MeasureText(A, af, new Size(W - 2 * Pad, 1000), TextFormatFlags.WordBreak).Height + 6;
    var area = Screen.PrimaryScreen.WorkingArea;
    Bounds = new Rectangle(area.Left + 16, area.Top + 16, W, Math.Min(h + 4, 460));
    hideTimer.Stop();
    if (!Visible) { Show(); anim.Start(); }
    if (hideAfterMs > 0) { hideTimer.Interval = hideAfterMs; hideTimer.Start(); }
    Invalidate();
  }
  public void Close2() { if (InvokeRequired) { BeginInvoke(new Action(Close2)); return; } hideTimer.Stop(); anim.Stop(); Hide(); }
  protected override void OnPaint(PaintEventArgs e) {
    var g = e.Graphics; g.SmoothingMode = SmoothingMode.AntiAlias; g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;
    // The orb: a ring of lights — breathing, listening (blue, with the voice), or thinking (a sweep).
    float cx = Pad + 14, cy = 27, n = 16;
    for (int i = 0; i < n; i++) {
      double a = i / n * 2 * Math.PI;
      float r = 10f * (1 + 0.04f * (float)Math.Sin(t * 1.6));
      float alpha = 0.45f; Color c = Color.White;
      if (State == "listening") { r *= 1 + 0.25f * wave * (float)Math.Sin(t * 9 + i); alpha = 0.95f; c = Color.FromArgb(157, 178, 255); }
      else if (State == "thinking") { double head = (t * 2.6) % (2 * Math.PI), d = Math.Abs(a - head); if (d > Math.PI) d = 2 * Math.PI - d; alpha = 0.25f + 0.75f * (float)Math.Max(0, 1 - d / 1.5); }
      using (var b = new SolidBrush(Color.FromArgb((int)(alpha * 255), c)))
        g.FillEllipse(b, cx + (float)Math.Cos(a) * r - 1.6f, cy + (float)Math.Sin(a) * r - 1.6f, 3.2f, 3.2f);
    }
    string st = State == "listening" ? "Listening" : State == "thinking" ? "Thinking" : "Yonna";
    TextRenderer.DrawText(g, st, status, new Point(Text0, 19), Color.FromArgb(140, 140, 146));
    if (State == "listening") {
      for (int i = 0; i < 9; i++) {
        float bh = 4 + 14 * wave * (0.55f + 0.45f * (float)Math.Abs(Math.Sin(t * 7 + i * 1.3)));
        using (var b = new SolidBrush(Color.FromArgb(190, 255, 255, 255))) g.FillRectangle(b, W - Pad - 9 * 6 + i * 6, 27 - bh / 2, 3, bh);
      }
    }
    int y = 50;
    if (Q.Length > 0) {
      var sz = TextRenderer.MeasureText(Q, qf, new Size(W - 2 * Pad, 1000), TextFormatFlags.WordBreak);
      TextRenderer.DrawText(g, Q, qf, new Rectangle(Pad, y, W - 2 * Pad, sz.Height), Color.FromArgb(150, 150, 156), TextFormatFlags.WordBreak);
      y += sz.Height + 6;
    }
    if (A.Length > 0) TextRenderer.DrawText(g, A, af, new Rectangle(Pad, y, W - 2 * Pad, Height - y), Color.FromArgb(245, 245, 245), TextFormatFlags.WordBreak);
  }
}

// "Take a look at my desk": the camera (the C270) in a small window, top
// right, through Windows' own camera system (as the Camera app uses): it
// starts in a moment and runs smoothly. Its picture goes with each question
// while it's open.
public class Camera : Quiet {
  // Waiting for Windows' camera calls, without the developer-kit helpers.
  static System.Threading.Tasks.Task<T> Done<T>(Windows.Foundation.IAsyncOperation<T> op) {
    var t = new System.Threading.Tasks.TaskCompletionSource<T>();
    op.Completed = (o, st) => { if (st == Windows.Foundation.AsyncStatus.Completed) t.TrySetResult(o.GetResults()); else t.TrySetException(new Exception(st.ToString())); };
    return t.Task;
  }
  static System.Threading.Tasks.Task Done(Windows.Foundation.IAsyncAction op) {
    var t = new System.Threading.Tasks.TaskCompletionSource<bool>();
    op.Completed = (o, st) => { if (st == Windows.Foundation.AsyncStatus.Completed) t.TrySetResult(true); else t.TrySetException(new Exception(st.ToString())); };
    return t.Task;
  }
  PictureBox view = new PictureBox();
  Windows.Media.Capture.MediaCapture capture;
  Windows.Media.Capture.Frames.MediaFrameReader reader;
  Bitmap latest; readonly object gate = new object();
  bool starting;
  public bool Open { get { return Visible && reader != null; } }
  public Camera() {
    BackColor = Color.FromArgb(10, 10, 11); Size = new Size(340, 255);
    view.Dock = DockStyle.Fill; view.SizeMode = PictureBoxSizeMode.Zoom; view.BackColor = BackColor;
    var close = new Label { Text = "\u2715", ForeColor = Color.White, BackColor = Color.FromArgb(40, 40, 44), Font = new Font("Segoe UI", 9f), TextAlign = ContentAlignment.MiddleCenter, Bounds = new Rectangle(306, 10, 24, 24), Cursor = Cursors.Hand };
    close.Click += (s, e) => Stop();
    Controls.Add(close); Controls.Add(view); close.BringToFront();
  }
  public void Start() {
    if (InvokeRequired) { BeginInvoke(new Action(Start)); return; }
    var area = Screen.PrimaryScreen.WorkingArea;
    Location = new Point(area.Right - Width - 16, area.Top + 16);
    Show();
    if (reader == null && !starting) Begin();
  }
  async void Begin() {
    starting = true;
    try {
      // The Logitech (C270) if it's there, else any colour camera.
      var groups = await Done(Windows.Media.Capture.Frames.MediaFrameSourceGroup.FindAllAsync());
      Windows.Media.Capture.Frames.MediaFrameSourceGroup pick = null;
      foreach (var g in groups) {
        bool color = false;
        foreach (var i in g.SourceInfos) if (i.SourceKind == Windows.Media.Capture.Frames.MediaFrameSourceKind.Color) color = true;
        if (!color) continue;
        if (pick == null || g.DisplayName.IndexOf("C270", StringComparison.OrdinalIgnoreCase) >= 0 || g.DisplayName.IndexOf("Logi", StringComparison.OrdinalIgnoreCase) >= 0) pick = g;
      }
      if (pick == null) { starting = false; return; }
      capture = new Windows.Media.Capture.MediaCapture();
      await Done(capture.InitializeAsync(new Windows.Media.Capture.MediaCaptureInitializationSettings {
        SourceGroup = pick, SharingMode = Windows.Media.Capture.MediaCaptureSharingMode.ExclusiveControl,
        MemoryPreference = Windows.Media.Capture.MediaCaptureMemoryPreference.Cpu,
        StreamingCaptureMode = Windows.Media.Capture.StreamingCaptureMode.Video }));
      Windows.Media.Capture.Frames.MediaFrameSource source = null;
      foreach (var s in capture.FrameSources.Values) if (s.Info.SourceKind == Windows.Media.Capture.Frames.MediaFrameSourceKind.Color) { source = s; break; }
      // 640×480 at the fastest rate it has: plenty for a small window, and quick.
      Windows.Media.Capture.Frames.MediaFrameFormat best = null;
      foreach (var f in source.SupportedFormats) {
        if (f.VideoFormat.Width != 640) continue;
        double fps = (double)f.FrameRate.Numerator / Math.Max(1, f.FrameRate.Denominator);
        if (best == null || fps > (double)best.FrameRate.Numerator / Math.Max(1, best.FrameRate.Denominator)) best = f;
      }
      if (best != null) await Done(source.SetFormatAsync(best));
      reader = await Done(capture.CreateFrameReaderAsync(source, Windows.Media.MediaProperties.MediaEncodingSubtypes.Bgra8));
      reader.AcquisitionMode = Windows.Media.Capture.Frames.MediaFrameReaderAcquisitionMode.Realtime;
      reader.FrameArrived += Arrived;
      await Done(reader.StartAsync());
    } catch { Stop(); }
    starting = false;
  }
  DateTime lastFrame = DateTime.MinValue;
  void Arrived(Windows.Media.Capture.Frames.MediaFrameReader r, Windows.Media.Capture.Frames.MediaFrameArrivedEventArgs e) {
    // About 20 pictures a second is plenty for a small window.
    if ((DateTime.Now - lastFrame).TotalMilliseconds < 45) { using (r.TryAcquireLatestFrame()) { } return; }
    lastFrame = DateTime.Now;
    using (var frame = r.TryAcquireLatestFrame()) {
      var sb = frame != null && frame.VideoMediaFrame != null ? frame.VideoMediaFrame.SoftwareBitmap : null;
      if (sb == null) return;
      if (sb.BitmapPixelFormat != Windows.Graphics.Imaging.BitmapPixelFormat.Bgra8)
        sb = Windows.Graphics.Imaging.SoftwareBitmap.Convert(sb, Windows.Graphics.Imaging.BitmapPixelFormat.Bgra8);
      int w = sb.PixelWidth, h = sb.PixelHeight;
      var buf = new Windows.Storage.Streams.Buffer((uint)(w * h * 4));
      sb.CopyToBuffer(buf);
      var bytes = new byte[buf.Length];
      using (var rd = Windows.Storage.Streams.DataReader.FromBuffer(buf)) rd.ReadBytes(bytes);
      var bmp = new Bitmap(w, h, PixelFormat.Format32bppRgb);
      var data = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.WriteOnly, PixelFormat.Format32bppRgb);
      for (int y = 0; y < h; y++) Marshal.Copy(bytes, y * w * 4, data.Scan0 + y * data.Stride, w * 4);
      bmp.UnlockBits(data);
      // The window gets a copy of its own: the picture kept for questions is
      // replaced (and freed) by the next one, perhaps while the window draws.
      var show = (Bitmap)bmp.Clone();
      Bitmap old;
      lock (gate) { old = latest; latest = bmp; }
      if (old != null) old.Dispose();
      try {
        BeginInvoke(new Action(() => { var shown = view.Image; view.Image = show; if (shown != null) shown.Dispose(); }));
      } catch { show.Dispose(); }
    }
  }
  public async void Stop() {
    if (InvokeRequired) { BeginInvoke(new Action(Stop)); return; }
    Hide();
    var r = reader; var c = capture; reader = null; capture = null;
    try { if (r != null) { r.FrameArrived -= Arrived; await Done(r.StopAsync()); r.Dispose(); } } catch { }
    try { if (c != null) c.Dispose(); } catch { }
    lock (gate) { if (latest != null) { latest.Dispose(); latest = null; } }
  }
  // The camera's picture now, as JPEG (base64), or null.
  public string Snapshot() {
    lock (gate) { return latest == null ? null : Talk.Jpeg(latest, 1024); }
  }
}

public class Talk : ApplicationContext {
  delegate IntPtr Hook(int code, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int id, Hook fn, IntPtr mod, uint thread);
  [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr h, int code, IntPtr w, IntPtr l);
  [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string name);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  const int VK_LCONTROL = 0xA2;
  static Hook keep; IntPtr hook;
  string mac, key, print;
  Box box = new Box(); Camera camera = new Camera(); Mic mic; SoundPlayer player;
  bool ctrlDown, other, talking; int asked;
  System.Windows.Forms.Timer holdTimer = new System.Windows.Forms.Timer();
  // Games in front: Ctrl is theirs (crouch), so holding it never means Yonna.
  static readonly string[] Games = { "valorant", "fortnite", "cs2", "csgo", "leagueoflegends", "r5apex", "overwatch", "gta5", "minecraft", "rocketleague", "cod" };

  public Talk(string mac, string key, string print) {
    this.mac = mac; this.key = key; this.print = print;
    ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
    // Only the Mac's own certificate is trusted for this.
    ServicePointManager.ServerCertificateValidationCallback = (s, cert, chain, err) =>
      cert != null && string.Equals(new System.Security.Cryptography.X509Certificates.X509Certificate2(cert).Thumbprint, this.print, StringComparison.OrdinalIgnoreCase);
    // Anything unexpected is written down, never shown as a Windows error box.
    Application.ThreadException += (s, e) => Oops(e.Exception);
    AppDomain.CurrentDomain.UnhandledException += (s, e) => Oops(e.ExceptionObject as Exception);
    var made = box.Handle; made = camera.Handle; // made on this (the window) thread, for answers coming from others
    box.Level = () => mic != null ? mic.Level : 0;
    holdTimer.Interval = 350;
    holdTimer.Tick += (s, e) => { holdTimer.Stop(); if (ctrlDown && !other && !talking && !GameInFront()) Begin(); };
    keep = OnKey;
    hook = SetWindowsHookEx(13, keep, GetModuleHandle(null), 0);
  }

  static void Oops(Exception e) {
    try { File.AppendAllText(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "Yonna", "talk-crash.log"), DateTime.Now.ToString("s") + " " + e + Environment.NewLine); } catch { }
  }

  bool GameInFront() {
    try {
      uint pid; GetWindowThreadProcessId(GetForegroundWindow(), out pid);
      var name = Process.GetProcessById((int)pid).ProcessName.ToLowerInvariant().Replace(" ", "");
      foreach (var g in Games) if (name.Contains(g)) return true;
    } catch { }
    return false;
  }

  IntPtr OnKey(int code, IntPtr wParam, IntPtr lParam) {
    if (code >= 0) {
      int vk = Marshal.ReadInt32(lParam); int msg = wParam.ToInt32();
      bool down = msg == 0x100 || msg == 0x104, up = msg == 0x101 || msg == 0x105;
      if (vk == VK_LCONTROL) {
        if (down && !ctrlDown) { ctrlDown = true; other = false; holdTimer.Stop(); holdTimer.Start(); }
        // Finished just after, not in here: Windows drops a keyboard hook that is slow to answer.
        else if (up) { ctrlDown = false; holdTimer.Stop(); if (talking) box.BeginInvoke(new Action(End)); }
      } else if (down && ctrlDown) { other = true; holdTimer.Stop(); }
    }
    return CallNextHookEx(hook, code, wParam, lParam);
  }

  void Begin() {
    // Talking over her stops her, and a slow answer still on its way is dropped.
    if (player != null) try { player.Stop(); } catch { }
    asked++;
    mic = new Mic();
    if (!mic.Start()) { box.Set("answer", "", "The microphone wouldn't start.", 4000); return; }
    talking = true;
    box.Set("listening", "", "", 0);
  }

  void End() {
    talking = false;
    var spoke = mic.Loud >= 3;
    var wav = mic.Stop();
    // Let go without a word: nothing happens.
    if (!spoke || wav.Length < 44 + 12000) { box.Close2(); return; }
    box.Set("thinking", "", "", 0);
    var screen = ScreenShot();
    var cam = camera.Open ? camera.Snapshot() : null;
    int mine = asked;
    ThreadPool.QueueUserWorkItem(_ => Ask(wav, screen, cam, mine));
  }

  public static string Jpeg(Image img, int maxWidth) {
    int w = Math.Min(maxWidth, img.Width), h = img.Height * w / img.Width;
    using (var small = new Bitmap(w, h)) {
      using (var g = Graphics.FromImage(small)) { g.InterpolationMode = InterpolationMode.HighQualityBicubic; g.DrawImage(img, 0, 0, w, h); }
      var enc = Array.Find(ImageCodecInfo.GetImageEncoders(), c => c.MimeType == "image/jpeg");
      var p = new EncoderParameters(1); p.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 70L);
      using (var m = new MemoryStream()) { small.Save(m, enc, p); return Convert.ToBase64String(m.ToArray()); }
    }
  }

  // The screen as it is now, for questions about what's on it.
  static string ScreenShot() {
    try {
      var b = Screen.PrimaryScreen.Bounds;
      using (var img = new Bitmap(b.Width, b.Height)) {
        using (var g = Graphics.FromImage(img)) g.CopyFromScreen(b.Location, Point.Empty, b.Size);
        return Jpeg(img, 1280);
      }
    } catch { return null; }
  }

  // One question to the Mac's Yonna; her answer.
  Dictionary<string, object> Post(JavaScriptSerializer ser, Dictionary<string, object> what) {
    var req = (HttpWebRequest)WebRequest.Create("https://" + mac + ":8443/pc/ask");
    req.Method = "POST"; req.ContentType = "application/json"; req.Timeout = 120000;
    req.Headers["x-yonna-pc-key"] = key;
    var body = Encoding.UTF8.GetBytes(ser.Serialize(what));
    using (var s = req.GetRequestStream()) s.Write(body, 0, body.Length);
    using (var r = (HttpWebResponse)req.GetResponse()) using (var rd = new StreamReader(r.GetResponseStream(), Encoding.UTF8))
      return ser.Deserialize<Dictionary<string, object>>(rd.ReadToEnd());
  }

  void Ask(byte[] wav, string screen, string cam, int mine) {
    try {
      var ser = new JavaScriptSerializer { MaxJsonLength = 64 * 1024 * 1024 };
      var j = Post(ser, new Dictionary<string, object> { { "wav", Convert.ToBase64String(wav) }, { "screen", screen }, { "camera", cam } });
      if (mine != asked) return; // a newer question has started
      // A question that needs eyes ("what's on my desk?"): the camera opened,
      // a picture taken, and the question sent again with it.
      if (j.ContainsKey("needCamera") && j["needCamera"] is bool && (bool)j["needCamera"]) {
        camera.Start();
        string shot = null;
        for (int i = 0; i < 25 && shot == null; i++) { Thread.Sleep(200); shot = camera.Snapshot(); }
        if (mine != asked) return;
        j = Post(ser, new Dictionary<string, object> { { "text", j["heard"] as string }, { "screen", screen }, { "camera", shot } });
        if (mine != asked) return;
      }
      string heard = j.ContainsKey("heard") ? j["heard"] as string : "";
      string say = j.ContainsKey("say") ? j["say"] as string : "";
      string voice = j.ContainsKey("wav") ? j["wav"] as string : null;
      string cameraDo = j.ContainsKey("camera") ? j["camera"] as string : null;
      if (cameraDo == "open") camera.Start();
      if (cameraDo == "close") camera.Stop();
      // Nothing heard: nothing to show.
      if (string.IsNullOrEmpty(heard) && string.IsNullOrEmpty(say)) { box.Close2(); return; }
      box.Set("answer", heard, say, 0);
      if (!string.IsNullOrEmpty(voice)) {
        // Played in the background, so holding Left Ctrl can cut it off at
        // once (a "synchronous" play can't be stopped midway); waited out here
        // for as long as it lasts, or until a new question starts.
        var bytes = Convert.FromBase64String(voice);
        int rate = bytes.Length > 32 ? BitConverter.ToInt32(bytes, 28) : 0; // bytes a second, from the WAV header
        player = new SoundPlayer(new MemoryStream(bytes));
        player.Play();
        var ends = DateTime.Now.AddMilliseconds(rate > 0 ? (bytes.Length - 44) * 1000.0 / rate + 150 : 0);
        while (DateTime.Now < ends && mine == asked) Thread.Sleep(50);
      }
      if (mine == asked) box.Set("answer", heard, say, say.Length > 80 ? 7000 : 3500);
    } catch {
      if (mine == asked) box.Set("answer", "", "I can't reach your Mac. Is it on and awake?", 6000);
    }
  }
}
'@

# Compiled by C#'s own compiler rather than Add-Type, which can't take the
# descriptions of Windows' camera system (WinRT) that the camera window uses.
$net = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$winmd = Join-Path $env:WINDIR 'System32\WinMetadata'
$cp = New-Object System.CodeDom.Compiler.CompilerParameters
$cp.GenerateInMemory = $true
foreach ($r in @('System.dll', 'System.Core.dll', 'System.Windows.Forms.dll', 'System.Drawing.dll', 'System.Web.Extensions.dll',
    (Join-Path $net 'System.Runtime.dll'), (Join-Path $net 'System.Runtime.InteropServices.WindowsRuntime.dll'),
    (Join-Path $winmd 'Windows.Foundation.winmd'), (Join-Path $winmd 'Windows.Media.winmd'),
    (Join-Path $winmd 'Windows.Graphics.winmd'), (Join-Path $winmd 'Windows.Storage.winmd'))) { [void]$cp.ReferencedAssemblies.Add($r) }
$built = (New-Object Microsoft.CSharp.CSharpCodeProvider).CompileAssemblyFromSource($cp, $code)
if ($built.Errors.HasErrors) {
  $built.Errors | Where-Object { -not $_.IsWarning } | ForEach-Object { "line $($_.Line): $($_.ErrorText)" } | Set-Content (Join-Path $env:ProgramData 'Yonna\talk-errors.txt')
  exit 1
}
Remove-Item (Join-Path $env:ProgramData 'Yonna\talk-errors.txt') -ErrorAction SilentlyContinue

# One copy only.
$mine = Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" | Where-Object { $_.CommandLine -like '*yonna-talk.ps1*' -and $_.ProcessId -ne $PID }
if ($mine) { exit }
[System.Windows.Forms.Application]::EnableVisualStyles()
# Errors go to talk-crash.log, not to a Windows error box (handled in Talk).
[System.Windows.Forms.Application]::SetUnhandledExceptionMode([System.Windows.Forms.UnhandledExceptionMode]::CatchException)
[System.Windows.Forms.Application]::Run([Activator]::CreateInstance($built.CompiledAssembly.GetType('Talk'), @($Mac, $Key, $Print)))
