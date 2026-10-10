// SPDX-License-Identifier: AGPL-3.0-only
import { clearToken, getToken, onTokenChange, saveToken, savedToken, setMemoryToken } from '../web/token';

let seq = 0;

/**
 * The GitHub token form, shared by the landing card and the viewer's top-bar popover. Typing keeps the token in memory; the user must
 * press "Save on this device" to write it to localStorage, and "Remove saved token" erases it. All instances stay in sync.
 */
export class TokenPanel {
  readonly el: HTMLElement;
  readonly input: HTMLInputElement;
  private save: HTMLButtonElement;
  private remove: HTMLButtonElement;
  private state: HTMLElement;
  private off: () => void;

  constructor() {
    const id = `gm-tok-${++seq}`;
    this.el = document.createElement('div');
    this.el.className = 'gm-tokenpanel';
    this.el.innerHTML = `
<p class="gm-tp-lead">Optional. Large repositories load through the GitHub API, which allows 60 requests an hour without a token and 5,000 with one.</p>
<label class="gm-sr" for="${id}">GitHub token</label>
<input id="${id}" class="gm-tp-input" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="github_pat_…" />
<div class="gm-tp-row">
  <button type="button" class="gm-btn gm-tp-save">Save on this device</button>
  <a class="gm-tp-link" href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer">Create a fine-grained token</a>
</div>
<p class="gm-tp-state" role="status"></p>
<button type="button" class="gm-btn is-quiet gm-tp-remove" hidden>Remove saved token</button>
<p class="gm-tp-privacy">Use a fine-grained token with <strong>Public repositories</strong> read access and nothing else. It stays in this browser&rsquo;s storage and is sent only to api.github.com. There is no other server or relay: Phloem talks to GitHub straight from your browser.</p>`;
    const q = <T extends HTMLElement>(s: string) => this.el.querySelector(s) as T;
    this.input = q('.gm-tp-input');
    this.save = q('.gm-tp-save');
    this.remove = q('.gm-tp-remove');
    this.state = q('.gm-tp-state');
    this.input.addEventListener('input', () => {
      setMemoryToken(this.input.value); // in memory only until Save
    });
    this.save.addEventListener('click', () => {
      const ok = saveToken(this.input.value);
      if (!ok) this.state.textContent = this.input.value.trim() ? 'This browser blocked storage, so the token stays in memory for this tab only.' : 'Enter a token first.';
    });
    this.remove.addEventListener('click', () => {
      clearToken();
      this.input.value = '';
      this.input.focus();
    });
    this.off = onTokenChange(() => this.refresh());
    this.input.value = getToken() ?? '';
    this.refresh();
  }

  focus(): void {
    this.input.focus();
  }

  destroy(): void {
    this.off();
  }

  private refresh(): void {
    const saved = savedToken();
    const cur = getToken();
    if (document.activeElement !== this.input) this.input.value = cur ?? '';
    const typed = this.input.value.trim();
    this.save.disabled = !typed || typed === saved;
    this.save.textContent = saved && typed === saved ? 'Saved on this device' : 'Save on this device';
    this.remove.hidden = !saved;
    this.state.textContent = !cur
      ? 'No token: 60 requests an hour.'
      : saved && typed === saved
        ? 'Saved on this device. Used for GitHub requests until you remove it.'
        : 'In use for this tab only. Press Save to keep it on this device.';
  }
}
