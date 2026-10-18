import {animate, hover, inView} from 'motion';
import {learningWalkthrough} from './learning-walkthrough.js';

const media = matchMedia('(prefers-reduced-motion: reduce)');
const active = new Map();
const touched = new Set();
const reduced = () => media.matches || document.body.classList.contains('daily-calm');
function run(element, frames, options = {}) {
  if (reduced()) return;
  touched.add(element);
  active.get(element)?.stop();
  const control = animate(element, frames, {duration: 0.45, ease: [0.22, 1, 0.36, 1], ...options});
  active.set(element, control);
  control.finished.then(() => { if (active.get(element) === control) active.delete(element); }).catch(() => {});
}
// Content stays visible without JavaScript. Only animate once it enters the viewport.
inView('.how-heading, .how-training, .how-flow-card, .how-benefit-grid article, .how-limits', element => {
  run(element, {opacity: [0.35, 1], y: [18, 0]});
}, {amount: 0.12});
hover('.how-benefit-grid article', element => {
  run(element, {y: -5}, {duration: 0.22});
  return () => run(element, {y: 0}, {duration: 0.22});
});
hover('#dailyLauncher', element => {
  const image = element.querySelector('img');
  if (image) run(image, {rotate: [0, -8, 7, -4, 0]}, {duration: 0.65});
});
function stopForReducedMotion() {
  if (!reduced()) return;
  for (const control of active.values()) control.stop();
  for (const element of touched) {
    element.style.removeProperty('transform');
    element.style.removeProperty('opacity');
  }
  active.clear();
  touched.clear();
}
media.addEventListener('change', stopForReducedMotion);
new MutationObserver(stopForReducedMotion).observe(document.body, {attributes: true, attributeFilter: ['class']});
learningWalkthrough({run});
