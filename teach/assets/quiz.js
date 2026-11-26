// Shared quiz component.
// Markup: <div class="quiz" data-answer="2"><div class="q">…</div>
//   <button class="opt">…</button> ×N <div class="fb">explanation</div></div>
// data-answer is the 0-based index of the right option.
(function () {
  const quizzes = document.querySelectorAll('.quiz[data-answer]');
  const score = document.querySelector('.score');
  let answered = 0, right = 0;
  function update() {
    if (score) score.textContent = `Ответов: ${answered} из ${quizzes.length}, верно с первой попытки: ${right}`;
  }
  quizzes.forEach((quiz) => {
    const answer = Number(quiz.dataset.answer);
    const opts = quiz.querySelectorAll('button.opt');
    const fb = quiz.querySelector('.fb');
    let first = true;
    opts.forEach((btn, i) => {
      btn.addEventListener('click', () => {
        if (i === answer) {
          btn.classList.add('right');
          if (fb) fb.classList.add('show');
          if (first) right++;
          if (!quiz.dataset.done) { quiz.dataset.done = '1'; answered++; }
          opts.forEach((b) => (b.disabled = true));
          update();
        } else {
          btn.classList.add('wrong');
          first = false;
        }
      });
    });
  });
  update();
})();
