/** Czech texts of "Zabezpečení účtu" (kept apart from cs.ts, which other open PRs change). */
export const account = {
  link: 'Zabezpečení účtu',
  title: 'Zabezpečení účtu',
  intro:
    'Novou ověřovací aplikaci (například v novém telefonu) nastavíte tady. Po dokončení se odhlásíte ze všech ostatních zařízení a dostanete nové záchranné kódy; staré kódy i stará aplikace přestanou platit.',
  password: 'Současné heslo',
  code: 'Kód ze současné aplikace (nebo nepoužitý záchranný kód)',
  submit: 'Pokračovat',
  scan: 'Naskenujte kód do NOVÉ ověřovací aplikace, nebo zadejte klíč ručně:',
  confirm: 'Dokončit výměnu',
  confirmLabel: 'Kód z nové ověřovací aplikace',
  password_help:
    'Heslo změníte přes „Zapomenuté heslo“ na přihlašovací stránce — přijde vám odkaz e-mailem.',
  back: 'Zpět na Moje hotely',
  everywhere: {
    title: 'Odhlásit ze všech zařízení',
    help: 'Ukončí přihlášení na všech zařízeních včetně tohoto, například po ztrátě telefonu nebo na sdíleném počítači.',
    start: 'Odhlásit všude',
    confirm: 'Opravdu odhlásit všude',
    cancel: 'Zrušit',
    failed: 'Odhlášení se nepodařilo dokončit. Jste stále přihlášeni; zkuste to prosím znovu.',
  },
  errors: {
    INVALID_CREDENTIALS: 'Heslo nebo kód nesouhlasí. Zkontrolujte je a zkuste to znovu.',
  } as Record<string, string>,
};
