window.__ModuleLoader__.load({
  id: 'dsh-screenshot-button',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /**
     * Shared mutable state for the composer button and the frame overlay (two
     * different slot entries). Read through useSyncExternalStore; every set
     * publishes a new immutable snapshot.
     */
    function createScreenshotSession() {
      let state = {
        phase: 'idle',
        dataBase64: null,
        width: 0,
        height: 0,
        error: null,
        onDone: null,
      };
      let listeners = [];
      return {
        get: () => state,
        set(patch) {
          state = { ...state, ...patch };
          for (const listener of [...listeners]) listener();
        },
        subscribe(listener) {
          listeners.push(listener);
          return () => { listeners = listeners.filter(entry => entry !== listener); };
        },
      };
    }

    /** Subscribe a component to one primitive-valued slice of the shared box. */
    function useBox(box, selector) {
      return React.useSyncExternalStore(box.subscribe, () => selector(box.get()));
    }

    /**
     * Normalize a drag rectangle into image-pixel crop coordinates. The drag
     * points are already converted to image space by `toImage`, so no further
     * scale division happens here — the earlier double conversion misplaced
     * both the drawn selection and the cropped region.
     */
    function cropRect(rect) {
      return {
        x: Math.max(0, Math.round(Math.min(rect.x1, rect.x2))),
        y: Math.max(0, Math.round(Math.min(rect.y1, rect.y2))),
        width: Math.max(1, Math.round(Math.abs(rect.x2 - rect.x1))),
        height: Math.max(1, Math.round(Math.abs(rect.y2 - rect.y1))),
      };
    }

        /** Scissors glyph, blades opening upward; color follows currentColor. */
        function ScissorsIcon() {
          return h('svg', {
            viewBox: '0 0 24 24', width: 15, height: 15, 'aria-hidden': true,
            style: { display: 'block' },
          },
          h('g', {
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.6,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          },
          h('circle', { cx: 5.5, cy: 18.5, r: 2.2 }),
          h('circle', { cx: 18.5, cy: 18.5, r: 2.2 }),
          h('path', { d: 'M7.4 17.2 19 6' }),
          h('path', { d: 'M16.6 17.2 5 6' }),
          ),
          );
        }

    /** Client module: composer button seat plus the frame-wide crop overlay. */
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const box = createScreenshotSession();
        const t = ctx.locale.bind('dsh-screenshot');

        const zhDict = {
          screenshot: '截图',
          buttonHint: '截图（Shift+点击：隐藏本窗口后截图）',
          direct: '直接截图',
          hide: '隐藏窗口截图',
          capturing: '截图…',
          cropHint: '拖拽选择区域，双击或 Enter 确认 / Esc 取消',
          confirm: '确认',
          cancel: '取消',
          attachFailed: '附带失败：',
          captureFailed: '截图失败：',
          noSession: '当前没有可用的输入框，无法附带图片',
          busyHint: '输入框正在等待回复（引导态），等本轮回复结束后再试',
          dismissHint: '点击关闭（8 秒后自动消失）',
        };
        const enDict = {
          screenshot: 'Screenshot',
          buttonHint: 'Screenshot (Shift+click: hide this window first)',
          direct: 'Capture now',
          hide: 'Hide window and capture',
          capturing: 'Capturing…',
          cropHint: 'Drag to select; double-click or Enter to confirm / Esc to cancel',
          confirm: 'Confirm',
          cancel: 'Cancel',
          attachFailed: 'Attach failed: ',
          captureFailed: 'Capture failed: ',
          noSession: 'No composer available to attach the image to',
          busyHint: 'the input is in steering mode while a reply is running; retry after it finishes',
          dismissHint: 'Click to dismiss (auto-clears after 8 s)',
        };
        ctx.effect(() => ctx.locale.register('dsh-screenshot', 'zh', zhDict));
        ctx.effect(() => ctx.locale.register('dsh-screenshot', 'en', enDict));

        /**
         * The shared stylesheet as a React element: rendered inside both slot
         * components, so the tags exist while any of them is mounted and are
         * removed when the last one unmounts. No `styles` global is required.
         */
        const STYLE_CSS = [
          '.dsh-shot-btn{display:inline-flex;align-items:center;justify-content:center;height:26px;',
          'min-width:26px;padding:0 6px;border:none;background:none;border-radius:5px;cursor:pointer;',
          'color:var(--dsw-alias-label-secondary);font-size:13px;font-family:inherit;}',
          '.dsh-shot-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}',
          '.dsh-shot-btn:disabled{cursor:default;opacity:.6;}',
          '.dsh-shot-error{position:absolute;bottom:30px;left:0;z-index:41;max-width:320px;padding:8px;cursor:pointer;',
          'background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-state-error-primary);',
          'border-radius:8px;font-size:12px;color:var(--dsw-alias-state-error-primary);user-select:none;}',
          '.dsh-shot-dismiss{margin-left:8px;border:none;background:none;cursor:pointer;color:inherit;',
          'text-decoration:underline;font-size:12px;padding:0;}',
          '.dsh-shot-stage{position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.72);',
          'overflow:hidden;outline:none;cursor:crosshair;}',
          '.dsh-shot-img{position:absolute;max-width:none;user-select:none;pointer-events:none;}',
          '.dsh-shot-sel{position:absolute;border:1.5px solid var(--dsw-alias-brand-primary);',
          'box-shadow:0 0 0 100000px rgba(0,0,0,.35);pointer-events:none;}',
          '.dsh-shot-bar{position:absolute;bottom:18px;left:50%;transform:translateX(-50%);display:flex;',
          'gap:10px;align-items:center;padding:6px 12px;border-radius:8px;',
          'background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);}',
          '.dsh-shot-bar span{font-size:12px;color:var(--dsw-alias-label-secondary);font-family:inherit;}',
          '.dsh-shot-ok{padding:3px 12px;border:none;border-radius:5px;cursor:pointer;',
          'background:var(--dsw-alias-brand-primary);color:#fff;font-size:12px;font-family:inherit;}',
          '.dsh-shot-ok:disabled{opacity:.5;cursor:default;}',
          '.dsh-shot-no{padding:3px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:5px;cursor:pointer;',
          'background:none;color:var(--dsw-alias-label-primary);font-size:12px;font-family:inherit;}',
        ].join('');
        function StyleTag() {
          return h('style', { 'data-plugin': 'dsh-screenshot-button' }, STYLE_CSS);
        }

        /** Post one diagnostic line to the Host half's log file. */
        function diag(message, data) {
          void fetch('/api/screenshot/v5/log', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ message, data }),
          }).catch(() => {});
        }

        /** Turn the cropped file into a draft image on the session input. */
        /**
         * Deliver the cropped PNG through a synthetic paste on the resident
         * composer textarea. The composer's own paste handler ingests pasted
         * files through its official intake (limit pre-check, rail render,
         * Host admission), so no package-private attachment API is touched.
         * @param {File} file - the cropped PNG.
         * @returns {boolean} whether the textarea was found and the paste dispatched.
         */
        function pasteIntoComposer(file) {
          // The installed composer is a contenteditable DIV (probed live:
          // `.GRgSLq_input` is the hashed module class). The host's paste
          // handler for files may attach to either element shape, so prefer
          // the contenteditable editor when present and keep the textarea
          // as the fallback.
          const editor = document.querySelector('[contenteditable="true"]');
          if (editor === null) return 'missing';
          const transfer = new DataTransfer();
          transfer.items.add(file);
          const event = new ClipboardEvent('paste', {
            clipboardData: transfer,
            bubbles: true,
            cancelable: true,
          });
          editor.dispatchEvent(event);
          diag('paste dispatched to contenteditable', {
            fileBytes: file.size,
            cls: String(editor.className).slice(0, 60),
          });
          return 'delivered';
        }

        /** Turn the cropped file into a draft image through the composer's paste intake. */
        function attachDraft(file) {
          diag('attach begin', { fileBytes: file.size, fileType: file.type });
          const outcome = pasteIntoComposer(file);
          if (outcome === 'missing') {
            box.set({ error: t('attachFailed') + 'no composer editor found' });
            return;
          }
          // The composer's paste handler owns the outcome from here (rail,
          // limits, notices); the dialog already closed on success.
          box.set({ error: null });
        }

        /**
         * Primary flow: the Host half opens its NATIVE full-screen overlay
         * (a topmost WinForms window over the whole screen, WeChat style) and
         * returns the cropped PNG. `mode: 'hide'` first minimizes the
         * configured window so it disappears from the capture. On any
         * native-path failure this shows an error so the user can retry.
         */
        function captureNative(mode) {
          box.set({ phase: 'capturing', error: null });
          fetch('/api/screenshot/v5/cropnative', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ mode }),
          })
            .then(async response => {
              const value = await response.json();
              if (value.status === 'cancelled') {
                box.set({ phase: 'idle' });
                return;
              }
              if (!response.ok || value.status !== 'ok') throw new Error(String(value.error ?? ('HTTP ' + String(response.status))));
              const file = new File(
                [await (await fetch('data:image/png;base64,' + String(value.dataBase64))).blob()],
                'screenshot-' + String(Date.now()) + '.png',
                { type: 'image/png' },
              );
              diag('native crop delivered', { mode, width: value.width, height: value.height, bytes: file.size });
              attachDraft(file);
              box.set({ phase: 'idle' });
            })
            .catch(error => {
              const message = error instanceof Error ? error.message : String(error);
              diag('native crop path failed', { mode, message });
              box.set({ phase: 'idle', error: t('captureFailed') + message });
            });
        }

        /** The composer tool-row control: single scissors button (Shift+click = hide-window capture). */
        function ScreenshotButton(props) {
          const phase = useBox(box, s => s.phase);
          const error = useBox(box, s => s.error);
          const rootRef = React.useRef(null);
          const capturing = phase === 'capturing';

          // The error box may be partially clipped by the tool row's overflow,
          // so it clears itself automatically and every click on it dismisses.
          React.useEffect(() => {
            if (error === null) return undefined;
            const timer = setTimeout(() => { box.set({ error: null }); }, 8000);
            return () => { clearTimeout(timer); };
          }, [error]);

          /** Native overlay path (full-screen, WeChat style) with shared guards. */
          const startNative = (mode) => {
            if (props.inputActions === undefined) {
              box.set({ error: t('noSession') });
              return;
            }
            box.set({ onDone: (file) => { attachDraft(file); } });
            captureNative(mode);
          };

          return h('div', { ref: rootRef, style: { position: 'relative', display: 'inline-flex' } },
            h(StyleTag),
            h('button', {
              type: 'button',
              className: 'dsh-shot-btn',
              title: t('buttonHint'),
              disabled: capturing,
              onClick: (event) => { startNative(event.shiftKey ? 'hide' : 'direct'); },
            },
            capturing ? h('span', { style: { fontSize: 11 } }, t('capturing')) : h(ScissorsIcon),
            ),
            error !== null && h('div', {
              role: 'alert',
              className: 'dsh-shot-error',
              title: t('dismissHint'),
              onClick: () => { box.set({ error: null }); },
            },
            error,
            h('span', { className: 'dsh-shot-dismiss' }, '×'),
            ),
          );
        }

        ctx.slots.inject('conversation.input.left', () => ctx.slots.register(
          { name: 'conversation.input.left', id: 'dsh-screenshot', order: 60, label: t('screenshot') },
          ScreenshotButton,
        ));
      },
    };
  },
});
