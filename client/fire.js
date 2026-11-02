// The first-run intro: the desk is dark until an agent is chosen, and connecting
// lights the fire, so the wait is the fun part. A connection that fails leaves
// embers and a way to recover. Once it holds, the desk opens outward from the fire.
// `?fire` in the address runs it again; `?notour` holds it back.

const BUSY = ['connecting', 'resetting', 'authenticating', 'configuring'];
const OPEN = ['ready', 'working', 'asleep'];
const BURN = 1700, QUICK_BURN = 800;   // long enough to see, however fast the agent answers
const REVEAL = 1500;

export function shouldLight(state, tabs) {
  const params = new URLSearchParams(location.search);
  if (params.has('notour')) return false;
  if (params.has('fire')) return true;
  return !state.lit && !tabs?.tabs?.some((tab) => tab.agent) && state.panels.some((panel) => panel.kind === 'chat');
}

const node = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text) n.textContent = text;
  return n;
};
const action = (text, run, cls) => {
  const b = node('button', cls, text);
  b.type = 'button';
  b.addEventListener('click', run);
  return b;
};

export function lightFire({ store, request, machine, onDone }) {
  const root = node('div', 'fire');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-labelledby', 'fireTitle');
  root.innerHTML = `
    <div class="fire-camp" aria-hidden="true">
      <div class="fire-glow"></div><div class="fire-log"></div><div class="fire-log b"></div><div class="fire-ember"></div>
      <div class="fire-flames"><i></i><i></i><i></i></div>
      <div class="fire-mascot"><span class="boot-tile"><i><b></b><b></b></i></span></div>
    </div>
    <h1 class="fire-title" id="fireTitle" tabindex="-1"></h1>
    <p class="fire-text" role="status"></p>
    <p class="fire-detail"></p>
    <div class="fire-agents"></div>
    <div class="fire-acts"></div>`;
  document.body.append(root);
  const title = root.querySelector('.fire-title'), text = root.querySelector('.fire-text');
  const detail = root.querySelector('.fire-detail'), agents = root.querySelector('.fire-agents');
  const acts = root.querySelector('.fire-acts'), flames = root.querySelector('.fire-flames');
  let drawn = '', started = Date.now(), least = BURN;
  let fresh = false;       // a connect was just asked for; the server has not said so yet
  let picking = false;     // back at the agents, past an error
  let failure = '';        // the request itself failed
  let quick = null;        // the agent used last, tried straight away
  let chosen = null;       // the agent being lit; the chat still names the last one until it answers
  let ending = false, done = false;

  const payload = (extra = {}) => ({ tab: store.acp?.tabId ?? null, sessionId: store.acp?.sessionId ?? null, ...extra });
  const nameOf = (id) => store.acp?.agents?.find((a) => a.id === id)?.name || 'your agent';

  function connect(agent) {
    chosen = agent; fresh = true; picking = false; failure = ''; started = Date.now();
    sync();
    request('/api/agent/connect', payload({ agent }))
      .catch((error) => { failure = error.message; })
      .finally(() => setTimeout(() => { fresh = false; sync(); }, failure ? 0 : 1500));
  }
  function cancel() {
    quick = null; fresh = false; picking = true; failure = '';
    request('/api/agent/cancel', payload()).catch(() => {}).finally(sync);
  }
  function signIn(methodId) {
    fresh = true; started = Date.now();
    sync();
    request('/api/agent/authenticate', payload({ methodId }))
      .catch((error) => { failure = error.message; })
      .finally(() => setTimeout(() => { fresh = false; sync(); }, failure ? 0 : 1500));
  }

  function drawAgents() {
    const list = store.acp?.agents || [];
    agents.replaceChildren(...list.map((agent) => {
      const b = action('', () => connect(agent.id), `fire-agent agent-provider agent-provider-${agent.mark}`);
      if (agent.icon) {
        const img = node('img', 'agent-icon');
        img.src = agent.icon; img.alt = '';
        b.append(img); b.classList.add('has-icon');
      }
      const label = node('span', 'fire-agent-label');
      label.append(node('b', '', agent.name));
      b.append(label);
      return b;
    }), (() => {
      const b = action('', leave, 'fire-agent agent-provider agent-provider-more');
      const label = node('span', 'fire-agent-label');
      label.append(node('b', '', 'Another agent'), node('small', 'plain', 'Any ACP agent works'));
      b.append(label);
      return b;
    })());
  }

  function show(stage, heading, words, { fine = '', buttons = () => [], sig = '' } = {}) {
    const next = JSON.stringify([stage, heading, fine, sig]);
    if (next === drawn) return;
    drawn = next;
    root.dataset.stage = stage;
    title.textContent = heading;
    text.replaceChildren(...[words].flat());
    detail.textContent = fine;
    detail.hidden = !fine;
    acts.replaceChildren(...buttons());
    if (stage === 'dark') drawAgents(); else agents.replaceChildren();
    (root.querySelector('.fire-agent, .fire-acts button') || title).focus({ preventScroll: true });
  }

  function burn(status) {
    const name = nameOf(chosen || store.acp?.agent);
    const signing = status === 'authenticating';
    show('lighting', signing ? 'Finish signing in.' : `Waking ${name}…`,
      signing ? 'Complete sign-in in your browser. The fire will keep going.' : 'Your desk opens the moment it’s ready.', {
        buttons: () => [action(quick ? 'Use another agent' : 'Cancel', cancel, 'fire-quiet')],
      });
  }

  function embers() {
    const acp = store.acp || {};
    const methods = acp.status === 'error' ? acp.authMethods || [] : [];
    const agent = chosen || acp.agent;
    const command = acp.agents?.find((a) => a.id === agent)?.signIn;
    const words = !acp.signIn ? `We couldn’t connect to ${nameOf(agent)}.`
      : command ? ['Run ', node('code', '', command), ' in a terminal, then try again.']
      : `${nameOf(agent)} signs in its own way. Follow its instructions, then try again.`;
    show('embers', acp.signIn ? `Sign in to ${nameOf(agent)}.` : 'The fire didn’t catch.', words, {
      fine: failure || (acp.signIn ? '' : acp.error || ''),
      sig: methods.map((m) => m.id).join(),
      buttons: () => [
        ...methods.map((m) => action(`Sign in with ${m.name}`, () => signIn(m.id), 'fire-primary')),
        action('Try again', () => connect(agent), methods.length ? 'fire-quiet' : 'fire-primary'),
        action('Choose another agent', () => { picking = true; failure = ''; sync(); }, 'fire-quiet'),
      ],
    });
  }

  function sync() {
    if (ending || done) return;
    const acp = store.acp || {};
    if (OPEN.includes(acp.status) && acp.sessionId) return reveal();
    if (BUSY.includes(acp.status)) return burn(acp.status);
    if (fresh) return burn();
    if (!picking && (failure || (acp.agent && acp.error))) return embers();
    show('dark', 'Who’s joining you by the fire?', 'Pick an agent. It can work on this project, and change this desk while you talk.', {
      sig: JSON.stringify(acp.agents),
    });
  }

  // Hold the flames until they have been seen, however fast the agent answered.
  function reveal() {
    ending = true;
    setTimeout(open, Math.max(0, least - (Date.now() - started)));
  }
  function open(then) {
    removeEventListener('keydown', onKey, true);
    const spot = flames.getBoundingClientRect();
    root.style.setProperty('--fire-x', `${spot.left}px`);
    root.style.setProperty('--fire-y', `${spot.top - 30}px`);
    root.classList.add('fire-lit');
    const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
    setTimeout(() => { done = true; root.remove(); onDone(); then?.(); }, calm ? 250 : REVEAL);
  }
  // Agents beyond the list are added in Chat, which knows how.
  function leave() {
    ending = true;
    open(() => document.querySelector('.win[data-id="chat"] .agent-provider-more')?.click());
  }

  function onKey(event) {
    if (event.key === 'Escape') { event.preventDefault(); if (!ending) leave(); }
    else if (event.key === 'Tab') {
      const items = [...root.querySelectorAll('button')];
      if (!items.length) return event.preventDefault();
      const i = items.indexOf(document.activeElement);
      event.preventDefault();
      items[(i + (event.shiftKey ? -1 : 1) + items.length) % items.length].focus();
    }
  }
  addEventListener('keydown', onKey, true);

  // A new project goes straight to the agent used last; another is one click away.
  const known = store.acp?.agents?.some((a) => a.id === machine?.agent);
  if (known && !store.acp?.agent) { quick = machine.agent; least = QUICK_BURN; connect(quick); }
  else sync();
  return { sync };
}
