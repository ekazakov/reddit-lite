// Progressive enhancement. Every form also works as a normal POST without this file.
(() => {
  const headers = { 'X-Requested-With': 'fetch' };

  async function send(form, data) {
    const res = await fetch(form.action, {
      method: 'POST',
      headers,
      body: data,
      credentials: 'same-origin',
    });
    if (res.status === 401) {
      const data = await res.json();
      location.href = data.login + '?next=' + encodeURIComponent(location.pathname + location.search);
      return null;
    }
    if (!res.ok) throw new Error('Request failed: ' + res.status);
    return res;
  }

  const handlers = {
    async vote(form, data) {
      const res = await send(form, data);
      if (!res) return;
      const { score, myVote } = await res.json();
      form.querySelector('.score').textContent = score;
      const [up, down] = form.querySelectorAll('button');
      up.className = myVote === 1 ? 'active' : '';
      down.className = myVote === -1 ? 'active down' : '';
    },

    async like(form, data) {
      const res = await send(form, data);
      if (!res) return;
      const { liked, likeCount } = await res.json();
      form.querySelector('.count').textContent = likeCount;
      form.querySelector('button').classList.toggle('active', liked);
    },

    async comment(form, data) {
      const res = await send(form, data);
      if (!res) return;
      const parentId = form.querySelector('[name=parent_id]')?.value;
      const list = document.getElementById(parentId ? 'children-' + parentId : 'comments');
      const tpl = document.createElement('template');
      tpl.innerHTML = (await res.text()).trim();
      const item = tpl.content.firstElementChild;
      if (parentId) list.append(item);
      else list.prepend(item);
      form.reset();
      form.closest('details')?.removeAttribute('open');
      item.scrollIntoView({ block: 'nearest' });
    },
  };

  document.addEventListener('submit', async (event) => {
    const form = event.target;
    const handler = handlers[form.dataset?.enhance];
    if (!handler) return;
    event.preventDefault();
    // Read the data first. A disabled submit button is left out of FormData.
    const data = new URLSearchParams(new FormData(form, event.submitter));
    const buttons = form.querySelectorAll('button');
    buttons.forEach((b) => (b.disabled = true));
    try {
      await handler(form, data);
    } catch (err) {
      console.error(err);
      // Fall back to a normal page post. Removing the marker stops this handler
      // from catching the submit again, and requestSubmit keeps the button value.
      buttons.forEach((b) => (b.disabled = false));
      delete form.dataset.enhance;
      form.requestSubmit(event.submitter);
      return;
    }
    buttons.forEach((b) => (b.disabled = false));
  });
})();
