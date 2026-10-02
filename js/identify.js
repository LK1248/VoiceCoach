// Interval identification: hear two notes, pick the interval.
import { INTERVALS, intervalBySemis, midiToName, pickItem } from './music.js?v=20261002151213';
import { settings, getRange, vowelsFor, soundText, instrumentFor } from './settings.js?v=20261002151213';

const $ = (id) => document.getElementById(id);
const AUTO_NEXT_DELAY = 1200; // ms to show a correct answer before moving on
const freshStats = () => ({ total: 0, correct: 0, streak: 0, best: 0, per: {} });

export class IdentifyMode {
  constructor(engine, status) {
    this.engine = engine;
    this.status = status;
    this.item = null;
    this.answered = false;
    this.stats = freshStats();

    $('idPlay').onclick = () => this.next();
    $('idReplay').onclick = () => this.play();
    $('idResetStats').onclick = () => { this.stats = freshStats(); this.renderStats(); };
    $('idFeedback').onclick = (e) => {
      const b = e.target.closest('button[data-act]');
      if (!b) return;
      if (b.dataset.act === 'next') this.next();
      if (b.dataset.act === 'correct') this.play();
      if (b.dataset.act === 'chosen') this.playSemis(+b.dataset.semis);
    };
    this.renderAnswers();
    this.renderStats();
  }

  onKey(e) {
    const key = e.key.toLowerCase();
    if (e.code === 'Space') {
      if (!this.item || this.answered) this.next(); // Next only once answered
    } else if (key === 'n') {
      this.next();
    } else if (key === 'a') {
      this.play();
    } else if (this.answered && key === 's') {
      this.play();
    } else if (this.answered && key === 'd' && this.chosen !== this.item.interval.semis) {
      this.playSemis(this.chosen);
    } else if (this.item && !this.answered) {
      const iv = INTERVALS.find((i) => i.key === key && settings.intervals.includes(i.semis));
      if (iv) this.answer(iv.semis);
    }
  }

  async next() {
    clearTimeout(this.autoNextTimer); // moving on manually cancels a pending auto-next
    try {
      this.item = pickItem(settings, getRange(), this.item);
    } catch (err) {
      $('idPrompt').textContent = err.message;
      return;
    }
    this.answered = false;
    $('idPrompt').textContent = 'Which interval was that?';
    $('idFeedback').innerHTML = '';
    $('idReplay').disabled = false;
    this.renderAnswers();
    await this.play();
  }

  async play() {
    if (!this.item) return;
    await this.playNotes([this.item.root, this.item.second]);
  }

  /** Play a different interval from the same root (to hear what the user chose). */
  async playSemis(semis) {
    const sign = this.item.dir === 'asc' ? 1 : -1;
    await this.playNotes([this.item.root, this.item.root + sign * semis]);
  }

  async playNotes(midis) {
    this.engine.stopAll();
    const r = await this.engine.playSequence(instrumentFor(this.item), midis, { dur: settings.noteDur, vowels: vowelsFor(this.item) });
    this.status.fallback(r.fallback);
  }

  renderAnswers() {
    const box = $('idAnswers');
    box.innerHTML = '';
    for (const iv of INTERVALS.filter((i) => settings.intervals.includes(i.semis))) {
      const b = document.createElement('button');
      b.dataset.semis = iv.semis;
      b.innerHTML = `<kbd class="key">${iv.key.toUpperCase()}</kbd><b>${iv.short}</b><small>${iv.name}</small>`;
      b.disabled = !this.item || this.answered;
      b.onclick = () => this.answer(iv.semis);
      box.append(b);
    }
    if (this.answered) this.markAnswers();
  }

  answer(semis) {
    if (!this.item || this.answered) return;
    this.answered = true;
    this.chosen = semis;
    const { item, stats } = this;
    const ok = semis === item.interval.semis;

    stats.total++;
    if (ok) stats.correct++;
    stats.streak = ok ? stats.streak + 1 : 0;
    stats.best = Math.max(stats.best, stats.streak);
    const p = (stats.per[item.interval.semis] ??= { c: 0, t: 0 });
    p.t++;
    if (ok) p.c++;

    this.renderAnswers();
    const desc = `${midiToName(item.root)} → ${midiToName(item.second)} · ${item.interval.name}, ${item.dir === 'asc' ? 'ascending' : 'descending'}${soundText(item)}`;
    const chosen = intervalBySemis(semis);
    $('idFeedback').innerHTML = `
      <div class="verdict ${ok ? 'ok' : 'no'}">${ok ? '✓ Correct!' : `✗ Not quite — you chose ${chosen.name}`}</div>
      <div class="detail">${desc}</div>
      <div class="controls">
        <button class="primary" data-act="next">Next ▶ <kbd>Space</kbd></button>
        <button data-act="correct">▶ Hear ${item.interval.short} <kbd>S</kbd></button>
        ${ok ? '' : `<button data-act="chosen" data-semis="${semis}">▶ Hear your answer (${chosen.short}) <kbd>D</kbd></button>`}
      </div>`;
    const auto = ok && settings.autoNext;
    $('idPrompt').textContent = auto ? 'Nice ear! Next one coming…' : ok ? 'Nice ear!' : 'Compare the two, then move on.';
    if (auto) {
      const item = this.item;
      this.autoNextTimer = setTimeout(() => {
        // Only if nothing else moved on meanwhile and Interval ID is still the active tab.
        if (this.item === item && document.body.dataset.mode === 'identify') this.next();
      }, AUTO_NEXT_DELAY);
    }
    this.renderStats();
  }

  markAnswers() {
    $('idAnswers').querySelectorAll('button').forEach((b) => {
      const s = +b.dataset.semis;
      b.disabled = true;
      if (s === this.item.interval.semis) b.classList.add('correct');
      else if (s === this.chosen) b.classList.add('wrong');
    });
  }

  renderStats() {
    const s = this.stats;
    const pct = s.total ? Math.round((100 * s.correct) / s.total) : 0;
    const rows = INTERVALS.filter((i) => s.per[i.semis])
      .map((i) => {
        const p = s.per[i.semis];
        const r = Math.round((100 * p.c) / p.t);
        return `<span>${i.name}</span><div class="bar"><div style="width:${r}%"></div></div><span class="num">${p.c}/${p.t}</span>`;
      })
      .join('');
    $('idStats').innerHTML = `
      <div class="summary">
        <div><b>${s.correct}/${s.total}</b>correct</div>
        <div><b>${pct}%</b>accuracy</div>
        <div><b>${s.streak}</b>streak</div>
        <div><b>${s.best}</b>best streak</div>
      </div>
      ${rows ? `<div class="bars">${rows}</div>` : '<div class="empty">Per-interval accuracy will appear here.</div>'}`;
  }
}
