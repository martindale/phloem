// SPDX-License-Identifier: AGPL-3.0-only
import { StatusDom } from '../statusdom';
import type { StatusAction, StatusView } from '../../web/statusview';
import './status.css';

/**
 * Loading / progress / partial-result messages while a history streams in. Centred and calm while nothing is on screen yet,
 * a compact pill under the top bar once the mold is growing. Errors with nothing loaded are shown on the landing card instead.
 */
export class StatusPill {
  readonly el: HTMLElement;
  private dom: StatusDom;
  private hideTimer = 0;

  constructor(root: HTMLElement, onAction: (a: StatusAction) => void) {
    this.el = document.createElement('div');
    this.el.className = 'gm-status';
    this.el.hidden = true;
    this.el.setAttribute('role', 'status');
    this.el.setAttribute('aria-live', 'polite');
    this.dom = new StatusDom(this.el, onAction);
    root.append(this.el);
  }

  set(v: StatusView | null): void {
    window.clearTimeout(this.hideTimer);
    if (!v) {
      this.el.hidden = true;
      return;
    }
    this.dom.set(v);
    this.el.hidden = false;
    this.el.classList.toggle('is-center', v.blocking && v.tone === 'busy');
    // a finished load with nothing to say fades away by itself; anything with notes or actions stays until dismissed
    if (v.tone === 'ok' && v.actions.length === 0) this.hideTimer = window.setTimeout(() => (this.el.hidden = true), 4500);
  }

  hide(): void {
    this.set(null);
  }
}
