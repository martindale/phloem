// SPDX-License-Identifier: AGPL-3.0-only
import { GIT_LOG_COMMAND } from '../../ingest/gitlog';
import { parseRepoInput } from '../../ingest/github';
import type { GithubRequest, LoadStatus } from '../../ingest/session';
import { bridge, type LandingApi } from '../../web/bridge';
import { FEATURED, describeStats, loadFeaturedIndex } from '../../web/featured';
import { sourceLink } from '../../web/source';
import { estimatePlan } from '../../web/plan';
import { describeStatus, type StatusAction } from '../../web/statusview';
import { getToken, onTokenChange } from '../../web/token';
import { DEFAULT_MAX, resolveMax, type MaxSetting } from '../../web/urlstate';
import { StatusDom } from '../statusdom';
import { TokenPanel } from '../tokenpanel';
import './landing.css';

const MAX_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'all', label: 'All available (within your quota)' },
  { value: '100', label: 'Latest 100 commits' },
  { value: '200', label: 'Latest 200 commits' },
  { value: '500', label: 'Latest 500 commits' },
  { value: '1000', label: 'Latest 1,000 commits' },
  { value: '3000', label: 'Latest 3,000 commits' },
];

const MARK = `<svg class="gm-mark" viewBox="0 0 28 28" width="26" height="26" aria-hidden="true" focusable="false">
  <g fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="2">
    <path d="M5 23c4-1 6-5 8-8s5-4 10-9"/><path d="M13 15c3 0 6 1 10 5"/><path d="M9 20c-2-3-3-6-3-10"/>
  </g>
  <g fill="currentColor"><circle cx="5" cy="23" r="2.6"/><circle cx="23" cy="6" r="1.9"/><circle cx="23" cy="20" r="1.9"/><circle cx="6" cy="10" r="1.9"/></g>
</svg>`;

export interface LandingInit {
  /** Pre-fill the repository field. */
  repo?: string;
  max?: MaxSetting;
  /** Called with a validated request. The landing hides itself afterwards. */
  onVisualize(req: GithubRequest, max: MaxSetting): void;
  onFile(file: File): void;
  /** The overlay was closed without choosing anything. */
  onClose?(): void;
}

/** The first thing a public visitor sees: one centred card over the growing mold. */
export class Landing implements LandingApi {
  readonly root: HTMLElement;
  private form: HTMLFormElement;
  private repo: HTMLInputElement;
  private err: HTMLElement;
  private maxSel: HTMLSelectElement;
  private estimate: HTMLElement;
  private tokenBox: HTMLDetailsElement;
  private tokenPanel = new TokenPanel();
  private go: HTMLButtonElement;
  private closeBtn: HTMLButtonElement;
  private banner: HTMLElement;
  private bannerDom: StatusDom;
  private opener: HTMLElement | null = null;
  private overlay = false;
  private busy = false;
  visible = false;

  constructor(
    host: HTMLElement,
    private init: LandingInit,
  ) {
    const featured = FEATURED.map(
      (f) =>
        `<li><button type="button" class="gm-feat" data-repo="${f.repo}"><span class="gm-feat-name">${f.name}</span><span class="gm-feat-meta" data-stats="${f.repo}">instant</span></button></li>`,
    ).join('');
    const opts = MAX_OPTIONS.map((o) => `<option value="${o.value}"${o.value === String(DEFAULT_MAX) ? ' selected' : ''}>${o.label}</option>`).join('');
    this.root = document.createElement('div');
    this.root.className = 'gm-landing';
    this.root.hidden = true;
    this.root.dataset.first = '';
    this.root.innerHTML = `
<header class="gm-land-top">
  <a class="gm-brand" href="./" aria-label="Phloem, home">${MARK}<span>Phloem</span></a>
  <button type="button" class="gm-land-close gm-btn" aria-label="Close" hidden>Close</button>
</header>
<main class="gm-land-main">
  <section class="gm-card" aria-labelledby="gm-h1">
    <h1 id="gm-h1">Watch a repository grow like a slime mold</h1>
    <p class="gm-lede">Paste a public GitHub repository. Folders become junctions, files become food, and every commit feeds the network.</p>
    <div class="gm-banner" role="status" hidden></div>
    <form class="gm-form" novalidate>
      <label for="gm-repo" class="gm-label">GitHub repository</label>
      <div class="gm-field">
        <input id="gm-repo" name="repo" type="text" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="owner/name or a github.com link" aria-describedby="gm-err" />
        <button type="submit" class="gm-btn is-primary gm-go">Visualize</button>
      </div>
      <p id="gm-err" class="gm-err" role="alert" hidden></p>
      <div class="gm-featured" role="group" aria-label="Featured repositories"><p class="gm-feat-label">Featured <span>prebuilt, instant, no GitHub requests</span></p><ul>${featured}</ul></div>
      <div class="gm-opt">
        <label for="gm-max">History</label>
        <select id="gm-max" name="max">${opts}</select>
      </div>
      <p class="gm-estimate" aria-live="polite"></p>
      <details class="gm-more gm-token-box">
        <summary>Add a GitHub token <span>(optional)</span></summary>
        <div class="gm-more-body gm-token-host"></div>
      </details>
    </form>
    <div class="gm-alt">
      <details class="gm-more gm-log-box">
        <summary>Upload a git log instead</summary>
        <div class="gm-more-body">
          <p>No rate limits, private repositories included, and the file never leaves your computer. In a clone of the repository run:</p>
          <div class="gm-cmd"><pre tabindex="0"><code class="gm-cmd-text"></code></pre><button type="button" class="gm-btn gm-copy">Copy</button></div>
          <label class="gm-file"><span class="gm-btn">Choose phloem.log</span><input type="file" accept=".log,.txt,.json,text/plain,application/json" /><span class="gm-file-hint">or drop it anywhere on the page</span></label>
        </div>
      </details>
    </div>
  </section>
</main>
<footer class="gm-land-foot">
  <p>Runs entirely in your browser. No accounts, no analytics, no cookies. <span class="gm-src-slot"></span></p>
</footer>`;
    this.root.querySelector('.gm-src-slot')!.replaceWith(sourceLink('gm-src'));
    host.append(this.root);

    const q = <T extends HTMLElement>(s: string) => this.root.querySelector(s) as T;
    this.form = q('form');
    this.repo = q('#gm-repo');
    this.err = q('#gm-err');
    this.maxSel = q('#gm-max');
    this.estimate = q('.gm-estimate');
    this.tokenBox = q('.gm-token-box');
    q('.gm-token-host').append(this.tokenPanel.el);
    this.go = q('.gm-go');
    this.closeBtn = q('.gm-land-close');
    this.banner = q('.gm-banner');
    this.bannerDom = new StatusDom(this.banner, (a) => this.bannerAction(a));
    q('.gm-cmd-text').textContent = GIT_LOG_COMMAND;

    if (init.repo) this.repo.value = init.repo;
    if (init.max !== undefined) this.maxSel.value = String(init.max);
    if (this.maxSel.value !== String(init.max ?? DEFAULT_MAX)) this.maxSel.value = String(DEFAULT_MAX);
    this.updateEstimate();

    this.form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.submit();
    });
    this.repo.addEventListener('input', () => this.setError(''));
    this.maxSel.addEventListener('change', () => this.updateEstimate());
    onTokenChange(() => this.updateEstimate());
    this.root.querySelectorAll<HTMLButtonElement>('.gm-feat').forEach((b) =>
      b.addEventListener('click', () => {
        this.repo.value = b.dataset.repo!;
        this.maxSel.value = 'all'; // a featured history is prebuilt in full
        this.updateEstimate();
        this.submit();
      }),
    );
    void loadFeaturedIndex().then((idx) => {
      for (const st of idx) {
        const el = this.root.querySelector<HTMLElement>(`[data-stats="${st.repo}"]`);
        if (el) el.textContent = `${describeStats(st)} · instant`;
      }
    });
    q('.gm-copy').addEventListener('click', (e) => void this.copyCommand(e.currentTarget as HTMLButtonElement));
    q<HTMLInputElement>('input[type=file]').addEventListener('change', (e) => {
      const input = e.target as HTMLInputElement;
      const f = input.files?.[0];
      input.value = '';
      if (f) {
        this.hide();
        init.onFile(f);
      }
    });
    this.root.addEventListener('animationend', () => delete this.root.dataset.first, { once: true });
    this.closeBtn.addEventListener('click', () => this.close());
    this.root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.overlay) this.close();
    });
    this.root.addEventListener('pointerdown', (e) => {
      if (this.overlay && e.target === this.root) this.close();
    });
  }

  // ------------------------------------------------------------ public API
  show(o: { overlay?: boolean; status?: LoadStatus | null; prefill?: string; badRepo?: string | null; focusToken?: boolean } = {}): void {
    this.opener = (document.activeElement as HTMLElement | null) ?? null;
    this.overlay = !!o.overlay;
    this.root.classList.toggle('is-overlay', this.overlay);
    this.closeBtn.hidden = !this.overlay;
    document.querySelectorAll<HTMLElement>('.gm-chrome').forEach((el) => this.overlay && el.setAttribute('inert', ''));
    this.setBusy(false);
    if (o.prefill !== undefined) this.repo.value = o.prefill;
    this.setStatus(o.status ?? null);
    this.setError(o.badRepo ? `“${o.badRepo}” does not look like a GitHub repository. Use owner/name or paste a github.com link.` : '');
    this.root.hidden = false;
    this.visible = true;
    document.documentElement.classList.add('gm-landing-open');
    if (o.focusToken) {
      this.tokenBox.open = true;
      this.tokenPanel.focus();
    } else if (this.overlay || !matchMedia('(pointer: coarse)').matches) this.repo.focus({ preventScroll: true });
  }

  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    this.root.hidden = true;
    delete this.root.dataset.first;
    document.documentElement.classList.remove('gm-landing-open');
    document.querySelectorAll<HTMLElement>('.gm-chrome').forEach((el) => el.removeAttribute('inert'));
    if (this.overlay && this.opener?.isConnected) this.opener.focus();
    this.overlay = false;
  }

  /** Error / rate-limit banner inside the card (for a load that produced nothing). */
  setStatus(s: LoadStatus | null): void {
    if (!s) {
      this.banner.hidden = true;
      return;
    }
    this.bannerDom.set(describeStatus(s, { hasToken: !!this.currentToken() }));
    this.banner.hidden = false;
    this.setBusy(false);
  }

  get tokenValue(): string | undefined {
    return this.currentToken();
  }

  // ------------------------------------------------------------ internals
  private close(): void {
    this.hide();
    this.init.onClose?.();
  }

  private bannerAction(a: StatusAction): void {
    if (a === 'token') {
      this.tokenBox.open = true;
      this.tokenPanel.focus();
    } else if (a === 'open' || a === 'dismiss') {
      this.banner.hidden = true;
      this.repo.focus();
    } else if (a === 'resume') {
      this.banner.hidden = true;
      this.hide();
      void bridge.whenApp().then((app) => app.resume());
    }
  }

  private currentToken(): string | undefined {
    return getToken();
  }

  private maxSetting(): MaxSetting {
    return this.maxSel.value === 'all' ? 'all' : Number(this.maxSel.value) || DEFAULT_MAX;
  }

  private updateEstimate(): void {
    const e = estimatePlan(this.maxSetting(), !!this.currentToken());
    this.estimate.textContent = e.short;
    this.estimate.title = e.summary;
    this.estimate.dataset.mode = e.mode;
  }

  private setError(msg: string): void {
    this.err.textContent = msg;
    this.err.hidden = !msg;
    if (msg) this.repo.setAttribute('aria-invalid', 'true');
    else this.repo.removeAttribute('aria-invalid');
  }

  private setBusy(b: boolean): void {
    this.busy = b;
    this.go.disabled = b;
    this.go.textContent = b ? 'Starting…' : 'Visualize';
  }

  private submit(): void {
    if (this.busy) return;
    const ref = parseRepoInput(this.repo.value);
    if (!ref) {
      this.setError(
        this.repo.value.trim()
          ? 'That does not look like a GitHub repository. Use owner/name or paste a github.com link, for example stemdeckapp/stemdeck.'
          : 'Enter a repository as owner/name, for example stemdeckapp/stemdeck.',
      );
      this.repo.focus();
      return;
    }
    this.setError('');
    const max = this.maxSetting();
    const token = this.currentToken();
    const req: GithubRequest = { repo: ref, token, maxCommits: resolveMax(max, !!token).max, mode: 'auto' };
    this.setBusy(true);
    this.banner.hidden = true;
    // the engine chunk may still be arriving: keep the card up (busy) until it can take the request
    void bridge.whenApp().then(() => {
      this.hide();
      this.init.onVisualize(req, max);
    });
  }

  private async copyCommand(btn: HTMLButtonElement): Promise<void> {
    try {
      await navigator.clipboard.writeText(GIT_LOG_COMMAND);
      btn.textContent = 'Copied';
    } catch {
      const range = document.createRange();
      range.selectNodeContents(this.root.querySelector('.gm-cmd-text')!);
      const sel = getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      btn.textContent = 'Press Ctrl+C';
    }
    setTimeout(() => (btn.textContent = 'Copy'), 2000);
  }
}
