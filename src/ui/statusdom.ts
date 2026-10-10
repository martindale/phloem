// SPDX-License-Identifier: AGPL-3.0-only
import type { StatusAction, StatusView } from '../web/statusview';

const LABELS: Record<StatusAction, string> = {
  cancel: 'Cancel',
  resume: 'Resume',
  token: 'Add a token',
  open: 'Try another repository',
  dismiss: 'Dismiss',
};

/**
 * Renders a StatusView into an element: headline, progress bar, details, notes and action buttons. Text and progress update in
 * place on every tick; the buttons are rebuilt only when the set of actions changes, so a click that spans an update still lands.
 */
export class StatusDom {
  private title = document.createElement('p');
  private bar = document.createElement('progress');
  private detail = document.createElement('p');
  private notes = document.createElement('div');
  private actions = document.createElement('div');
  private key = '';

  constructor(
    readonly el: HTMLElement,
    private onAction: (a: StatusAction) => void,
  ) {
    this.title.className = 'gm-st-title';
    this.bar.className = 'gm-st-bar';
    this.bar.setAttribute('aria-label', 'Loading progress');
    this.detail.className = 'gm-st-detail';
    this.notes.className = 'gm-st-notes';
    this.actions.className = 'gm-st-actions';
    el.replaceChildren(this.title, this.bar, this.detail, this.notes, this.actions);
  }

  set(v: StatusView): void {
    this.el.dataset.tone = v.tone;
    this.title.textContent = v.title;
    this.bar.hidden = v.tone !== 'busy';
    if (v.fraction !== undefined) {
      this.bar.max = 1;
      this.bar.value = Math.max(0, Math.min(1, v.fraction));
    } else this.bar.removeAttribute('value');
    this.detail.textContent = v.detail ?? '';
    this.detail.hidden = !v.detail;
    const cur = Array.from(this.notes.children, (c) => c.textContent);
    if (cur.length !== v.notes.length || v.notes.some((n, i) => cur[i] !== n)) {
      this.notes.replaceChildren(
        ...v.notes.map((n) => {
          const p = document.createElement('p');
          p.textContent = n;
          return p;
        }),
      );
    }
    const key = `${v.actions.join(',')}|${v.resumeLabel}`;
    if (key !== this.key) {
      this.key = key;
      this.actions.replaceChildren(
        ...v.actions.map((a, i) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = `gm-btn${i === 0 && a !== 'cancel' && a !== 'dismiss' ? ' is-primary' : ''}${a === 'dismiss' ? ' is-quiet' : ''}`;
          b.textContent = a === 'resume' ? v.resumeLabel : LABELS[a];
          b.addEventListener('click', () => this.onAction(a));
          return b;
        }),
      );
    }
    this.actions.hidden = v.actions.length === 0;
  }
}
