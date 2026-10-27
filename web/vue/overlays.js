/* 设置 Slide-over / 预览浮层：Esc、焦点循环、背景 inert 与滚动锁都在这里。 */
window.VDACC_OVERLAYS = {
  install({ settingsOpen, previewUrl, watch, nextTick }) {
    let returnFocus = null;
    const activeDialog = () => document.querySelector(previewUrl.value ? '.preview-box' : '.slideover');

    const close = () => {
      if (previewUrl.value) { previewUrl.value = ''; return; }
      settingsOpen.value = false;
    };

    const onKeydown = (e) => {
      if (!settingsOpen.value && !previewUrl.value) return;
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      if (e.key !== 'Tab') return;
      const nodes = [...(activeDialog()?.querySelectorAll(
        'button:not(:disabled), input:not(:disabled), select, a[href], video[controls]',
      ) || [])].filter((el) => el.getClientRects().length);
      const first = nodes[0], last = nodes.at(-1);
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    };

    watch([settingsOpen, previewUrl], async ([openSettings, openPreview], [wasSettings, wasPreview]) => {
      const opened = openSettings || openPreview;
      if (opened && !wasSettings && !wasPreview) returnFocus = document.activeElement;
      document.body.style.overflow = opened ? 'hidden' : '';
      const app = document.querySelector('.app');
      if (app) app.inert = !!opened;
      await nextTick();
      if (openSettings || openPreview) activeDialog()?.querySelector('button')?.focus();
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
