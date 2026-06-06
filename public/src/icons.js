import 'iconify-icon';
import { addCollection } from 'iconify-icon';
import { icons as pixelarticonsCollection } from '@iconify-json/pixelarticons';
import { icons as pixelCollection } from '@iconify-json/pixel';

addCollection(pixelarticonsCollection);
addCollection(pixelCollection);

function iconRef(name) {
  return name.includes(':') ? name : `pixelarticons:${name}`;
}

function applyIconAttrs(el, name) {
  el.setAttribute('icon', iconRef(name));
}

export function iconEl(name, options = {}) {
  const el = document.createElement('iconify-icon');
  applyIconAttrs(el, name);
  if (options.className) el.className = options.className;
  if (options.title) {
    el.setAttribute('title', options.title);
    el.setAttribute('aria-hidden', 'false');
  } else {
    el.setAttribute('aria-hidden', 'true');
  }
  return el;
}

export function setButtonLabel(button, text) {
  if (!button) return;
  const label = button.querySelector('.btn-label');
  if (label) label.textContent = text;
  else button.textContent = text;
}

export function bindIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((host) => {
    const name = host.dataset.icon;
    if (!name) return;
    let icon = host.querySelector('iconify-icon');
    if (!icon) {
      icon = iconEl(name);
      const pos = host.dataset.iconPos || 'start';
      if (pos === 'end') host.appendChild(icon);
      else host.insertBefore(icon, host.firstChild);
    } else {
      applyIconAttrs(icon, name);
    }
  });
}

export function setIcon(host, name) {
  if (!host) return;
  let icon = host.querySelector('iconify-icon');
  if (!icon) {
    icon = iconEl(name);
    host.insertBefore(icon, host.firstChild);
  } else {
    applyIconAttrs(icon, name);
  }
}

bindIcons(document);