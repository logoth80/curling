<#
.SYNOPSIS
    Asks Windows, out loud, whether an .ico works - and what it draws.

.DESCRIPTION
    A favicon has to satisfy two decoders that agree far less often than people
    assume. A browser will read anything; the Windows icon machinery is the fussy
    one, and its failures are silent: File Explorer simply draws nothing, or draws
    a black square.

    This script goes through the shell path - shell32!ExtractIconEx, which is what
    Explorer and shortcuts use - for both the large and the small icon, then reads
    the bits Windows actually built and compares them against the DIB entry in the
    file. It reports the colours on the pixels both sides agree are opaque, counts
    the transparent pixels that came back solid (a black square), and exits 1 when
    anything is wrong.

    ExtractIconEx's second argument is an icon *index*, not a size selector: one
    call at index 0 returns the large and the small handle together. Getting that
    wrong once produced a "the shell produced no icon" that was this script's bug,
    not the file's.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools/check_windows_icon.ps1
    powershell -ExecutionPolicy Bypass -File tools/check_windows_icon.ps1 favicon.ico C:\temp\renders
#>
param(
  [string]$Path = 'favicon.ico',
  [string]$RenderDir = ''
)

$full = (Resolve-Path -LiteralPath $Path).Path
Add-Type -Language CSharp -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;

public static class WindowsIconCheck {
  [StructLayout(LayoutKind.Sequential)]
  struct ICONINFO { public bool fIcon; public int xHot; public int yHot; public IntPtr hbmMask; public IntPtr hbmColor; }

  [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern uint ExtractIconEx(string file, int index, IntPtr[] big, IntPtr[] small, uint n);
  [DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetIconInfo(IntPtr h, out ICONINFO info);

  static int bad = 0;

  // The entries in the file, as {size, isPng, pixels-top-down-ARGB} for a DIB.
  static string Directory(byte[] f) {
    int count = BitConverter.ToUInt16(f, 4);
    var s = "";
    for (int i = 0; i < count; i++) {
      int at = 6 + 16 * i;
      int px = f[at] == 0 ? 256 : f[at];
      uint size = BitConverter.ToUInt32(f, at + 8), off = BitConverter.ToUInt32(f, at + 12);
      bool png = f[off] == 0x89 && f[off + 1] == (byte)'P';
      s += (s.Length > 0 ? " " : "") + px + ":" + (png ? "png" : "dib");
    }
    return count + " entries (" + s + ")";
  }

  static int[,] DibPixels(byte[] f, int px) {
    // Find the DIB entry of that size, then un-flip its bottom-up rows and its
    // BGRA order into top-down ARGB so it can be compared to a bitmap.
    int count = BitConverter.ToUInt16(f, 4);
    for (int i = 0; i < count; i++) {
      int at = 6 + 16 * i;
      int w = f[at] == 0 ? 256 : f[at];
      uint size = BitConverter.ToUInt32(f, at + 8), off = BitConverter.ToUInt32(f, at + 12);
      if (w != px || f[off] == 0x89) continue;
      var pxs = new int[px, px];
      for (int r = 0; r < px; r++)
        for (int x = 0; x < px; x++) {
          int o = (int)off + 40 + (r * px + x) * 4;
          pxs[x, px - 1 - r] = (f[o + 3] << 24) | (f[o + 2] << 16) | (f[o + 1] << 8) | f[o];
        }
      return pxs;
    }
    return null;
  }

  static void Check(string path, string tag, IntPtr h, byte[] file) {
    if (h == IntPtr.Zero) { Console.WriteLine("  " + tag + ": NO HANDLE - the shell could not build this icon"); bad++; return; }
    try {
      ICONINFO ii; GetIconInfo(h, out ii);
      using (var bmp = Bitmap.FromHicon(h)) {
        if (bmp.Width <= 0 || bmp.Height <= 0) { Console.WriteLine("  " + tag + ": empty bitmap"); bad++; return; }
        var corner = bmp.GetPixel(0, 0);
        Console.WriteLine("  " + tag + ": " + bmp.Width + "x" + bmp.Height
          + "  corner=ARGB(" + corner.A + "," + corner.R + "," + corner.G + "," + corner.B + ")");

        bool cornerSolid = corner.A > 0 && corner.R < 8 && corner.G < 8 && corner.B < 8;
        if (cornerSolid) { Console.WriteLine("    PROBLEM: the corner is a solid near-black pixel - an AND-mask or alpha bug"); bad++; }

        var mine = DibPixels(file, bmp.Width);
        if (mine == null) { Console.WriteLine("    (no DIB entry of this size to compare against; PNG-only entry)"); return; }
        int opaque = 0, maxDiff = 0, solid = 0, softCleared = 0, holes = 0;
        for (int y = 0; y < bmp.Height; y++)
          for (int x = 0; x < bmp.Width; x++) {
            int want = mine[x, y];
            var got = bmp.GetPixel(x, y);
            int wantA = (want >> 24) & 0xFF;
            bool wantOpaque = wantA >= 250;
            bool gotOpaque = got.A >= 250;
            if (wantOpaque && gotOpaque) {
              opaque++;
              int d = Math.Max(Math.Abs(((want >> 16) & 0xFF) - got.R),
                      Math.Max(Math.Abs(((want >> 8) & 0xFF) - got.G), Math.Abs((want & 0xFF) - got.B)));
              if (d > maxDiff) maxDiff = d;
            }
            if (wantA == 0 && got.A > 0) solid++;          // clear in the file, drawn solid
            if (wantA > 0 && wantA < 250 && got.A == 0) softCleared++;  // the 1-bit mask overrode a soft edge
            if (wantA >= 250 && got.A == 0) holes++;       // an opaque pixel went missing: a real fault
          }
        Console.WriteLine("    compared " + opaque + " fully-opaque pixels against the DIB in the file: max channel diff " + maxDiff);
        Console.WriteLine("    clear pixels the shell drew solid: " + solid + "   soft pixels the 1-bit mask resolved to clear: " + softCleared);
        if (maxDiff > 8) { Console.WriteLine("    PROBLEM: the colours the shell drew do not match the file"); bad++; }
        if (holes > 0) { Console.WriteLine("    PROBLEM: " + holes + " opaque pixels went missing"); bad++; }
        if (RenderDir != null && RenderDir.Length > 0)
          bmp.Save(Path.Combine(RenderDir, "windows_drew_" + tag + ".png"), System.Drawing.Imaging.ImageFormat.Png);
      }
    } finally { DestroyIcon(h); }
  }

  static string RenderDir = "";

  public static int Run(string path, string renderDir) {
    RenderDir = renderDir ?? "";
    var file = File.ReadAllBytes(path);
    if (BitConverter.ToUInt16(file, 2) != 1) { Console.WriteLine("not an icon directory"); return 1; }
    Console.WriteLine("icon: " + path + "  " + file.Length + " bytes  " + Directory(file));
    var big = new IntPtr[1]; var small = new IntPtr[1];
    uint got = ExtractIconEx(path, 0, big, small, 1);
    Console.WriteLine("ExtractIconEx(index 0): count=" + got);
    if (got == 0) { Console.WriteLine("PROBLEM: the shell produced no icon at all"); return 1; }
    Check(path, "large", big[0], file);
    Check(path, "small", small[0], file);
    Console.WriteLine(bad == 0 ? "RESULT: Windows reads it and draws the colours in the file"
                               : "RESULT: " + bad + " problem(s)");
    return bad == 0 ? 0 : 1;
  }
}
'@
exit [WindowsIconCheck]::Run($full, $RenderDir)
