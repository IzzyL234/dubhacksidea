// This walkthrough explains the real update path; it never trains on example data.
export function learningWalkthrough({run}) {
  const list = document.querySelector('.how-training-loop');
  if (!list) return;
  const steps = [
    ['Collect the inputs.', 'The session records available context such as place, workspace conditions and elapsed time. Missing details stay explicitly unknown; a photo supplies observations, not a productivity rating.'],
    ['Use your actual outcome.', 'After the session, you rate productivity and mood. Confirmed distractions help distinguish a one-off interruption from a persistent condition. Optional notes provide context for the coordinator.'],
    ['Update the personal model.', 'The linked rating updates the linear reward estimates used by LinUCB. Demo and real examples have equal base weight, while a confirmed session-specific interruption reduces that observation’s influence. The language model itself is not retrained.'],
    ['Inform the next decision.', 'Future options receive updated productivity and mood estimates. LinUCB also accounts for uncertainty. The coordinator considers that evidence alongside current availability, and calendar tools recheck proposed changes before execution.'],
  ];
  const panel = document.createElement('div');
  panel.className = 'learning-walkthrough';
  panel.id = 'learningWalkthrough';
  panel.setAttribute('role', 'region');
  panel.setAttribute('aria-label', 'Learning step explanation');
  panel.setAttribute('aria-live', 'polite');
  const heading = document.createElement('h3');
  const description = document.createElement('p');
  panel.append(heading, description);
  list.after(panel);
  const buttons = [...list.children].map((item, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.append(...item.childNodes);
    button.setAttribute('aria-controls', panel.id);
    button.addEventListener('click', () => select(index));
    item.append(button);
    return button;
  });
  function select(index) {
    buttons.forEach((button, i) => button.setAttribute('aria-pressed', String(i === index)));
    heading.textContent = steps[index][0];
    description.textContent = steps[index][1];
    run(panel, {opacity: [0.6, 1], y: [7, 0]}, {duration: 0.28});
  }
  select(0);
  const detail = document.getElementById('flowDetail');
  if (detail) new MutationObserver(() => run(detail, {opacity: [0.65, 1], y: [9, 0]}, {duration: 0.3})).observe(detail, {childList: true});
}
