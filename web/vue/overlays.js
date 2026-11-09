/* 设置 Slide-over / 预览浮层 / 分析浮层：Esc、焦点循环、背景 inert 与滚动锁都在这里。 */
window.VDACC_OVERLAYS = {
  install({ settingsOpen, previewUrl, analysis, watch, nextTick }) {
    let returnFocus = null;

    // 三层的叠放顺序：预览在最上，其次分析，最后设置
    const activeDialog = () => {
      if (previewUrl.value) return document.querySelector('.preview-box');
      if (analysis.value) return document.querySelector('.analysis-box');
      return document.querySelector('.slideover');
    };
    const anyOpen = () => !!(settingsOpen.value || previewUrl.value || analysis.value);

    const close = () => {
      if (previewUrl.value) { previewUrl.value = ''; return; }
      if (analysis.value) { analysis.value = null; return; }
      settingsOpen.value = false;
    };

    const onKeydown = (e) => {
      if (!anyOpen()) return;
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      if (e.key !== 'Tab') return;
      const nodes = [...(activeDialog()?.querySelectorAll(
        'button:not(:disabled), input:not(:disabled), select, a[href], video[controls]',
      ) || [])].filter((el) => el.getClientRects().length);
      const first = nodes[0], last = nodes.at(-1);
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    };

    // 任何一层打开就把主界面置为 inert；关掉预览但仍留着分析时，焦点要回到分析里，
    // 否则用户按 Esc 关掉播放器后焦点落在 body 上，键盘就走不动了。
    watch([settingsOpen, previewUrl, analysis], async ([openSettings, openPreview, openAnalysis],
      [wasSettings, wasPreview, wasAnalysis]) => {
      const opened = !!(openSettings || openPreview || openAnalysis);
      const wasOpen = !!(wasSettings || wasPreview || wasAnalysis);
      if (opened && !wasOpen) returnFocus = document.activeElement;
      document.body.style.overflow = opened ? 'hidden' : '';
      const app = document.querySelector('.app');
      if (app) app.inert = opened;
      await nextTick();
      if (opened) activeDialog()?.querySelector('button')?.focus();
      else if (returnFocus?.isConnected) returnFocus.focus();
    });

    window.addEventListener('keydown', onKeydown);

    return () => {
      window.removeEventListener('keydown', onKeydown);
      document.body.style.overflow = '';
      const app = document.querySelector('.app');
      if (app) app.inert = false;
    };
  },
};
