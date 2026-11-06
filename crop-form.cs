using System;
using System.Collections.Generic;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace DshShot
{
    public class CropForm : Form
    {
        readonly Image _shot;
        readonly Bitmap _dim;
        readonly Pen _pen;
        readonly Pen _hoverPen;
        readonly Font _font;
        readonly Brush _textBrush;
        readonly Brush _backBrush;
        readonly GlyphButton _okButton;
        readonly GlyphButton _cancelButton;

        /// <summary>
        /// Tool button in the WeChat/QQ screenshot idiom: a solid colored
        /// circle with a thick white vector glyph — green check to confirm,
        /// red cross to cancel. The strokes are drawn as paths with round
        /// caps rather than font glyphs, so they stay crisp and evenly thick.
        /// </summary>
        sealed class GlyphButton : Control
        {
            public enum GlyphKind { Check, Cross }

            readonly GlyphKind _kind;
            readonly System.Drawing.Color _fill;
            bool _hover;
            bool _suppressHover;

            public GlyphButton(GlyphKind kind, System.Drawing.Color fill)
            {
                _kind = kind;
                _fill = fill;
                SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint | ControlStyles.SupportsTransparentBackColor, true);
                Size = new System.Drawing.Size(28, 28);
                Cursor = Cursors.Hand;
                Visible = false;
            }

            protected override void OnPaint(PaintEventArgs e)
            {
                var g = e.Graphics;
                g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                // Paint the whole control rect in the backdrop color first so
                // the corners around the circle match it instead of showing
                // the dark overlay behind the control.
                var whole = new System.Drawing.Rectangle(0, 0, Width, Height);
                using (var corner = new SolidBrush(_hover
                    ? System.Drawing.Color.FromArgb(255, 235, 236, 239)
                    : System.Drawing.Color.FromArgb(255, 224, 226, 230)))
                {
                    g.FillRectangle(corner, whole);
                }
                var rect = new System.Drawing.Rectangle(1, 1, Width - 3, Height - 3);
                using var pen = new Pen(_hover ? Darken(_fill, 0.8f) : _fill, 2.6f)
                {
                    StartCap = System.Drawing.Drawing2D.LineCap.Round,
                    EndCap = System.Drawing.Drawing2D.LineCap.Round,
                    LineJoin = System.Drawing.Drawing2D.LineJoin.Round,
                };
                var c = Width / 2f;
                var r = Width * 0.22f;
                if (_kind == GlyphKind.Check)
                {
                    g.DrawLines(pen, new[]
                    {
                        new PointF(c - r, c + 0.1f * r),
                        new PointF(c - 0.25f * r, c + r),
                        new PointF(c + r, c - r),
                    });
                }
                else
                {
                    g.DrawLine(pen, c - r, c - r, c + r, c + r);
                    g.DrawLine(pen, c + r, c - r, c - r, c + r);
                }
            }

            static System.Drawing.Color Darken(System.Drawing.Color c, float factor)
            {
                return System.Drawing.Color.FromArgb(c.A,
                    (int)(c.R * factor),
                    (int)(c.G * factor),
                    (int)(c.B * factor));
            }

            protected override void OnMouseEnter(EventArgs e)
            {
                base.OnMouseEnter(e);
                // When the selection ends the pointer often sits exactly where
                // the buttons appear; that first enter is a positional
                // coincidence, not intent, so suppress the hover state until
                // the pointer has left the button once.
                if (_suppressHover)
                {
                    return;
                }
                _hover = true;
                Invalidate();
            }

            protected override void OnMouseLeave(EventArgs e)
            {
                base.OnMouseLeave(e);
                _hover = false;
                _suppressHover = false;
                Invalidate();
            }

            /// <summary>
            /// Called when the buttons reappear with the selection: the first
            /// MouseEnter after this is ignored until the pointer leaves.
            /// </summary>
            public void SuppressNextHover()
            {
                _suppressHover = true;
                _hover = false;
                Invalidate();
            }

            protected override void OnPaintBackground(PaintEventArgs e) { }
        }
        readonly Rectangle[] _windows;
        Rectangle _sel;
        Rectangle _hover;
        Point _start;
        bool _dragging;
        bool _selIsWindow;
        bool _moving;
        Point _moveOrigin;
        Rectangle _moveStartSel;
        bool _resizing;
        int _resizeEdge;
        Point _resizeOrigin;
        Rectangle _resizeStartSel;

        // Edge hit bands: bits for N/E/S/W, corners combine both axes.
        const int EdgeN = 1, EdgeE = 2, EdgeS = 4, EdgeW = 8;

        /// <summary>
        /// Hit-test the finished selection's border band (±5 px inside and
        /// outside the rect) and return the edge bits; 0 when the pointer is
        /// clearly inside or outside.
        /// </summary>
        int EdgeAt(Point p)
        {
            if (_sel.Width < 2 || _sel.Height < 2) return 0;
            var band = 10;
            var expanded = _sel;
            expanded.Inflate(band, band);
            if (!expanded.Contains(p)) return 0;
            if (_sel.Contains(p)) return 0;
            var edges = 0;
            if (Math.Abs(p.Y - _sel.Top) <= band) edges |= EdgeN;
            if (Math.Abs(p.Y - _sel.Bottom) <= band) edges |= EdgeS;
            if (Math.Abs(p.X - _sel.Left) <= band) edges |= EdgeW;
            if (Math.Abs(p.X - _sel.Right) <= band) edges |= EdgeE;
            return edges;
        }

        static Cursor EdgeCursor(int edges)
        {
            if (edges == EdgeN) return Cursors.SizeNS;
            if (edges == EdgeS) return Cursors.SizeNS;
            if (edges == EdgeW) return Cursors.SizeWE;
            if (edges == EdgeE) return Cursors.SizeWE;
            if (edges == (EdgeN | EdgeW) || edges == (EdgeS | EdgeE)) return Cursors.SizeNWSE;
            if (edges == (EdgeN | EdgeE) || edges == (EdgeS | EdgeW)) return Cursors.SizeNESW;
            return Cursors.Cross;
        }

        /// <summary>Apply one resize delta to the anchor rectangle.</summary>
        void ApplyResize(Point p)
        {
            var left = _resizeStartSel.Left;
            var top = _resizeStartSel.Top;
            var right = _resizeStartSel.Right;
            var bottom = _resizeStartSel.Bottom;
            var dx = p.X - _resizeOrigin.X;
            var dy = p.Y - _resizeOrigin.Y;
            if ((_resizeEdge & EdgeW) != 0) left += dx;
            if ((_resizeEdge & EdgeE) != 0) right += dx;
            if ((_resizeEdge & EdgeN) != 0) top += dy;
            if ((_resizeEdge & EdgeS) != 0) bottom += dy;
            // Clamp to the screen and enforce a 2x2 minimum.
            left = Math.Max(0, Math.Min(Width - 2, left));
            top = Math.Max(0, Math.Min(Height - 2, top));
            right = Math.Max(2, Math.Min(Width, right));
            bottom = Math.Max(2, Math.Min(Height, bottom));
            if (right - left < 2) right = left + 2;
            if (bottom - top < 2) bottom = top + 2;
            _sel = Rectangle.FromLTRB(left, top, right, bottom);
            Invalidate();
        }

        static class WinApi
        {
            public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

            [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc proc, IntPtr lParam);
            [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
            [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
            [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int index);
            [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
            [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attribute, out int value, int size);
            [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attribute, out Rect value, int size);

            public const int GWL_EXSTYLE = -20;
            public const long WS_EX_TOOLWINDOW = 0x80L;
            public const int DWMWA_CLOAKED = 14;
            public const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;

            [StructLayout(LayoutKind.Sequential)]
            public struct Rect
            {
                public int Left;
                public int Top;
                public int Right;
                public int Bottom;
            }
        }

        public int RX { get; private set; }
        public int RY { get; private set; }
        public int RW { get; private set; }
        public int RH { get; private set; }
        public bool Ok { get; private set; }

        public CropForm(Image shot)
        {
            _shot = shot;
            DoubleBuffered = true;
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint | ControlStyles.ResizeRedraw, true);
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.Manual;
            TopMost = true;
            KeyPreview = true;
            Cursor = Cursors.Cross;
            BackColor = System.Drawing.Color.Black;
            _pen = new Pen(System.Drawing.Color.FromArgb(255, 0, 174, 255), 1.5f);
            _hoverPen = new Pen(System.Drawing.Color.FromArgb(255, 0, 174, 255), 2f);
            _font = new Font("Segoe UI", 9f);
            _textBrush = new SolidBrush(System.Drawing.Color.White);
            _backBrush = new SolidBrush(System.Drawing.Color.FromArgb(200, 20, 20, 20));
            _windows = EnumerateWindows();
            _dim = MakeDim();
            _okButton = MakeToolButton(GlyphButton.GlyphKind.Check, System.Drawing.Color.FromArgb(255, 7, 193, 96));
            _okButton.Click += (s, e) => Confirm();
            _cancelButton = MakeToolButton(GlyphButton.GlyphKind.Cross, System.Drawing.Color.FromArgb(255, 250, 81, 81));
            _cancelButton.Click += (s, e) => Cancel();
            Controls.Add(_cancelButton);
            Controls.Add(_okButton);
        }

        /// <summary>
        /// Enumerate the visible top-level windows in z-order with DWM
        /// extended-frame bounds — the visually accurate rectangle. Skips the
        /// overlay itself, cloaked UWP windows, tool windows, minimized and
        /// off-screen entries, and anything too small to select.
        /// </summary>
        Rectangle[] EnumerateWindows()
        {
            var handles = new IntPtr[4096];
            var count = 0;
            WinApi.EnumWindows((hWnd, _) =>
            {
                if (count < handles.Length) handles[count++] = hWnd;
                return true;
            }, IntPtr.Zero);
            var result = new Rectangle[count];
            var n = 0;
            var self = Handle;
            for (var i = 0; i < count; i++)
            {
                var h = handles[i];
                if (h == self || !WinApi.IsWindowVisible(h)) continue;
                if (WinApi.IsIconic(h)) continue;
                // Cloaked UWP apps still report visible but render nothing.
                var cloaked = 0;
                if (WinApi.DwmGetWindowAttribute(h, WinApi.DWMWA_CLOAKED, out cloaked, 4) == 0 && cloaked != 0) continue;
                if ((WinApi.GetWindowLong(h, WinApi.GWL_EXSTYLE) & WinApi.WS_EX_TOOLWINDOW) != 0) continue;
                WinApi.Rect r;
                if (WinApi.DwmGetWindowAttribute(h, WinApi.DWMWA_EXTENDED_FRAME_BOUNDS, out r, 16) != 0) continue;
                var rect = Rectangle.FromLTRB(r.Left, r.Top, r.Right, r.Bottom);
                if (rect.Width < 60 || rect.Height < 60) continue;
                var screenW = WinApi.GetSystemMetrics(16);
                var screenH = WinApi.GetSystemMetrics(17);
                if (rect.Right < 0 || rect.Bottom < 0 || rect.Left > screenW || rect.Top > screenH) continue;                result[n++] = rect;
            }
            Array.Resize(ref result, n);
            return result;
        }

        /// <summary>First hit in z-order wins (EnumWindows is topmost-first).</summary>
        Rectangle? WindowAt(Point p)
        {
            foreach (var r in _windows)
            {
                if (r.Contains(p)) return r;
            }
            return null;
        }

        GlyphButton MakeToolButton(GlyphButton.GlyphKind kind, System.Drawing.Color fill)
        {
            return new GlyphButton(kind, fill);
        }

        void PositionTools()
        {
            var margin = 8;
            var gap = 6;
            // The cancel button sits left, the confirm (green check) right.
            var totalW = _cancelButton.Width + gap + _okButton.Width;
            var x = _sel.X + _sel.Width - totalW;
            var y = _sel.Y + _sel.Height + margin;
            if (y + _okButton.Height > Height) y = _sel.Y - _okButton.Height - margin;
            if (x < 0) x = 0;
            if (x + totalW > Width) x = Width - totalW;
            _cancelButton.Location = new Point(x, y);
            _okButton.Location = new Point(x + _cancelButton.Width + gap, y);
            _okButton.Visible = true;
            _cancelButton.Visible = true;
            // The pointer often rests where the buttons just appeared; the
            // first enter is ignored until the pointer has left once.
            _okButton.SuppressNextHover();
            _cancelButton.SuppressNextHover();
            _okButton.BringToFront();
            _cancelButton.BringToFront();
            // Paint forensics showed the first-appearance state is correct but
            // the screen kept showing a stale darker copy until the next mouse
            // move repainted: the form's own paint pass can run after the
            // buttons' and overwrite their area. Force a synchronous repaint
            // of both buttons so they are the last writers of their pixels.
            _okButton.Invalidate();
            _okButton.Update();
            _cancelButton.Invalidate();
            _cancelButton.Update();
        }

        Bitmap MakeDim()
        {
            var dim = new Bitmap(_shot.Width, _shot.Height);
            using (var g = Graphics.FromImage(dim))
            {
                g.DrawImage(_shot, 0, 0, _shot.Width, _shot.Height);
                using (var wash = new SolidBrush(System.Drawing.Color.FromArgb(120, 0, 0, 0)))
                {
                    g.FillRectangle(wash, 0, 0, dim.Width, dim.Height);
                }
            }
            return dim;
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            // Bounds are set here, after the handle exists and DPI awareness
            // has settled — setting them in the constructor can virtualize the
            // coordinates on the first shot after a process start. The size
            // comes from the system metrics so a scale-factor change made
            // while the process is resident is picked up. TopMost is
            // re-asserted so the overlay always sits above the app window.
            var w = WinApi.GetSystemMetrics(16);  // SM_CXSCREEN
            var h = WinApi.GetSystemMetrics(17);  // SM_CYSCREEN
            Bounds = new System.Drawing.Rectangle(0, 0, w, h);
            TopMost = true;
            Activate();
            BringToFront();
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            if (e.Button != MouseButtons.Left) return;
            // Border band of a finished selection: start an anchored resize.
            var edge = EdgeAt(e.Location);
            if (edge != 0)
            {
                _resizing = true;
                _resizeEdge = edge;
                _resizeOrigin = e.Location;
                _resizeStartSel = _sel;
                _okButton.Visible = false;
                _cancelButton.Visible = false;
                return;
            }
            // A finished selection turns into a movable object: pressing
            // inside it starts a move instead of a new selection.
            if (_sel.Width >= 2 && _sel.Height >= 2 && _sel.Contains(e.Location))
            {
                _moving = true;
                _moveOrigin = e.Location;
                _moveStartSel = _sel;
                _okButton.Visible = false;
                _cancelButton.Visible = false;
                return;
            }
            _start = e.Location;
            _dragging = true;
            _selIsWindow = false;
            // A click landing on a highlighted window selects the whole window;
            // dragging from anywhere re-enters free-form selection.
            var hit = WindowAt(_start);
            if (hit.HasValue)
            {
                _sel = hit.Value;
                _selIsWindow = true;
                PositionTools();
            }
            else
            {
                _sel = new Rectangle(_start.X, _start.Y, 0, 0);
            }
            _hover = Rectangle.Empty;
            _okButton.Visible = false;
            _cancelButton.Visible = false;
            Invalidate();
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            base.OnMouseMove(e);
            if (_resizing)
            {
                ApplyResize(e.Location);
                return;
            }
            if (_moving)
            {
                var dx = e.X - _moveOrigin.X;
                var dy = e.Y - _moveOrigin.Y;
                var x = Math.Max(0, Math.Min(Width - _moveStartSel.Width, _moveStartSel.X + dx));
                var y = Math.Max(0, Math.Min(Height - _moveStartSel.Height, _moveStartSel.Y + dy));
                _sel = new Rectangle(x, y, _moveStartSel.Width, _moveStartSel.Height);
                Invalidate();
                return;
            }
            if (_dragging)
            {
                if (_selIsWindow)
                {
                    // Started as a window pick; a real drag converts it to
                    // free-form selection from the press point.
                    if (Math.Abs(e.X - _start.X) > 6 || Math.Abs(e.Y - _start.Y) > 6)
                    {
                        _selIsWindow = false;
                        _sel = new Rectangle(_start.X, _start.Y, 0, 0);
                    }
                    else
                    {
                        return;
                    }
                }
                var x = Math.Min(_start.X, e.X);
                var y = Math.Min(_start.Y, e.Y);
                _sel = new Rectangle(x, y, Math.Abs(e.X - _start.X), Math.Abs(e.Y - _start.Y));
                Invalidate();
                return;
            }
            // Idle: edge bands show resize cursors, inside shows the move
            // cursor, everywhere else shows the window hover highlight.
            if (_sel.Width >= 2 && _sel.Height >= 2)
            {
                var edge = EdgeAt(e.Location);
                if (edge != 0)
                {
                    Cursor = EdgeCursor(edge);
                    _hover = Rectangle.Empty;
                    return;
                }
                if (_sel.Contains(e.Location))
                {
                    if (Cursor != Cursors.SizeAll)
                    {
                        Cursor = Cursors.SizeAll;
                        _hover = Rectangle.Empty;
                        Invalidate();
                    }
                    return;
                }
            }
            if (Cursor != Cursors.Cross) Cursor = Cursors.Cross;
            var hit = WindowAt(e.Location);
            var newHover = hit ?? Rectangle.Empty;
            if (newHover != _hover)
            {
                _hover = newHover;
                Invalidate();
            }
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            base.OnMouseUp(e);
            if (e.Button == MouseButtons.Left)
            {
                _dragging = false;
                _moving = false;
                _resizing = false;
                if (_sel.Width >= 2 && _sel.Height >= 2) PositionTools();
            }
        }

        protected override void OnMouseDoubleClick(MouseEventArgs e)
        {
            base.OnMouseDoubleClick(e);
            Confirm();
        }

        protected override void OnMouseClick(MouseEventArgs e)
        {
            base.OnMouseClick(e);
            if (e.Button == MouseButtons.Right) Cancel();
        }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            base.OnKeyDown(e);
            if (e.KeyCode == Keys.Escape) Cancel();
            if (e.KeyCode == Keys.Enter) Confirm();
        }

        void Confirm()
        {
            if (_sel.Width < 2 || _sel.Height < 2) return;
            RX = _sel.X; RY = _sel.Y; RW = _sel.Width; RH = _sel.Height;
            Ok = true;
            Close();
        }

        void Cancel()
        {
            Ok = false;
            Close();
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            var g = e.Graphics;
            g.DrawImage(_dim, 0, 0);
            // Hover highlight while no free-form selection is being drawn.
            var showHover = !(_dragging && !_selIsWindow) && !_hover.IsEmpty;
            if (showHover)
            {
                g.DrawImage(_shot, _hover, _hover, GraphicsUnit.Pixel);
                g.DrawRectangle(_hoverPen, _hover);
            }
            if (_sel.Width >= 1 && _sel.Height >= 1)
            {
                g.DrawImage(_shot, _sel, _sel, GraphicsUnit.Pixel);
                g.DrawRectangle(_pen, _sel);
                var text = _sel.Width + " x " + _sel.Height;
                var size = g.MeasureString(text, _font);
                var lx = Math.Min(_sel.X + 4, Width - (int)size.Width - 12);
                var ly = Math.Max(4, _sel.Y - (int)size.Height - 10);
                g.FillRectangle(_backBrush, lx, ly, (int)size.Width + 8, (int)size.Height + 4);
                g.DrawString(text, _font, _textBrush, lx + 4, ly + 2);
            }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                _shot.Dispose();
                _dim.Dispose();
                _pen.Dispose();
                _hoverPen.Dispose();
                _font.Dispose();
                _textBrush.Dispose();
                _backBrush.Dispose();
            }
            base.Dispose(disposing);
        }
    }
}
