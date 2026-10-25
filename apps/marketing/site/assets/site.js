// AYVO marketing site — progressive enhancement only; every page works without it.
// 1. The footer year. 2. Switching the language keeps the section being read: the language
//    links get the id of the section at the top of the viewport (the same ids on every page).
(() => {
  const year = document.querySelector('[data-year]');
  if (year) year.textContent = String(new Date().getFullYear());

  const sections = Array.from(document.querySelectorAll('main section[id]'));
  const current = () => {
    let id = '';
    for (const s of sections) {
      if (s.getBoundingClientRect().top <= 140) id = s.id;
    }
    return id;
  };
  for (const link of document.querySelectorAll('a[data-lang]')) {
    link.addEventListener('click', () => {
      const id = current();
      const url = new URL(link.getAttribute('href'), window.location.href);
      url.hash = id && id !== 'top' ? id : '';
      link.setAttribute('href', url.pathname + url.hash);
    });
  }
})();
