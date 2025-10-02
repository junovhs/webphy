// Utility functions

export function download(blob, filename) {
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    try {
      URL.revokeObjectURL(url);
    } catch (e) {}
    a.remove();
  }, 60000);
}

export function toast(message, kind = 'ok') {
  const t = document.getElementById('toast');
  t.textContent = message;
  t.className = 'toast ' + (kind === 'ok' ? 'ok' : 'err');
  t.classList.remove('hidden');
  setTimeout(() => t.classList.add('hidden'), 2200);
}

export function waitForVideoSeeked(videoElement) {
  return new Promise(resolve => {
    videoElement.addEventListener('seeked', resolve, { once: true });
  });
}