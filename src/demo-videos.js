// Load Drive only after the visitor asks to play; never autoplay or change sharing.
export function demoVideos() {
  for (const button of document.querySelectorAll('[data-drive-demo]')) {
    button.addEventListener('click', () => {
      const id = button.dataset.driveDemo;
      if (!/^[A-Za-z0-9_-]+$/.test(id)) return;
      const frame = document.createElement('iframe');
      frame.src = `https://drive.google.com/file/d/${id}/preview`;
      frame.title = button.dataset.title || 'Daywise example';
      frame.allowFullscreen = true;
      frame.referrerPolicy = 'no-referrer';
      frame.setAttribute('allow', 'fullscreen');
      frame.setAttribute('tabindex', '0');
      const target = button.closest('.demo-media');
      target.replaceChildren(frame);
      frame.focus();
    });
  }
}
