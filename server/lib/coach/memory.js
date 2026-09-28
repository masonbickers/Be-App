import { isoDay, text as safeText } from './metrics.js';
import { createHash } from 'node:crypto';
const clean = s => String(s || '').replace(/^(?:remember(?: that)?|please remember(?: that)?|save(?: this)?(?: as (?:a )?memory)?[: ,]*)\s*/i, '').trim().slice(0, 400);
export function memoryCandidate(input) {
  const text = clean(input);
  if (!text || text.length < 8 || /\b(today|yesterday|tonight|this morning|this week|this month|for now|calories|kcal|weigh(?:t)?|slept|last night)\b/i.test(text)) return null;
  let key, category;
  if (/\b(protein|carb|fat)\s+target|\d+\s*(?:g|grams)\b/i.test(text)) return null;
  if (/\b(train|training|work out)\b.*\b(one|two|three|four|five|six|seven|[1-7])\s*(?:days|times)\s*(?:a|per|each)\s*week/i.test(text)) {
    key = 'schedule.frequency';
    category = 'schedule';
  } else if (/\b(prefer|like)\b/i.test(text) && /\b(morning|evening|afternoon)\b/i.test(text) && /\b(train|training|workout|exercise)/i.test(text)) {
    key = 'schedule.time';
    category = 'preference';
  } else if (/\b(can|can(?:not|'t)|can't|cannot|don't|do not)\s+train.*\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)/i.test(text)) {
    key = 'schedule.' + text.match(/sunday|monday|tuesday|wednesday|thursday|friday|saturday/i)[0].toLowerCase();
    category = 'schedule';
  } else if (/\b(chronic|injury|injuries|limitation|recurring)\b|\bgets? sore (?:after|when)|\bhurts? (?:after|when)/i.test(text) && /knee|back|shoulder|ankle|hip|wrist/i.test(text)) {
    key = 'limitation.' + text.match(/knee|back|shoulder|ankle|hip|wrist/i)[0].toLowerCase();
    category = 'injury';
  } else if (/\b(?:only have|access to|equipment)\b/i.test(text) && /dumbbell|barbell|machine|gym|equipment|band|kettlebell/i.test(text)) {
    key = 'equipment.available';
    category = 'equipment';
  } else if (/\b(goal|aim|target)\b/i.test(text) && /\b(run|race|bench|lift|squat)\b/i.test(text)) {
    key = 'performance.' + (/run|race/i.test(text) ? 'run' : /bench/i.test(text) ? 'bench' : 'lift');
    category = 'performance_goal';
  } else if (/\b(prefer|dislike|hate|avoid|allerg|intoleran|equipment|normally|usually|coaching|limitation)\w*\b/i.test(text)) {
    category = /food|meal|eat|diet|allerg|intoleran/i.test(text) ? 'dietary_preference' : 'preference';
    // Stable exact fact; free-form facts with no unambiguous topic are not guessed to conflict.
    key = 'fact.' + createHash('sha256').update(text.toLowerCase().replace(/[.!]+$/, '')).digest('hex').slice(0, 24);
  } else return null;
  return {
    text,
    key,
    category
  };
}
// Domain matching keeps constraints available even when the question uses different
// words (for example dumbbells -> strength or dairy -> breakfast).
const memoryDomains = [
  {fact: /morning|evening|afternoon|schedule|routine|availability|days? a week/i, query: /when|timing|schedule|routine|hard(?:er)? session|workout|training|train|plan/i},
  {fact: /dumbbell|barbell|kettlebell|equipment|gym|resistance band|machine/i, query: /strength|lift|workout|exercise|squat|press|training|train|plan|equipment|gym/i},
  {fact: /dairy|peanut|gluten|vegan|vegetarian|diet|allerg|intoleran|food|meal/i, query: /breakfast|lunch|dinner|snack|meal|food|eat|diet|nutrition|fuel|protein/i},
  {fact: /injur|chronic|pain|soreness|knee|ankle|shoulder|limitation/i, query: /injur|pain|sore|knee|ankle|shoulder|run|exercise|squat|lift|strength|hill|terrain|speed safely|injury risk/i},
];
const queryStopWords = new Set(['the','and','you','your','what','that','this','about','with','have','for','can','should','give','how','tell','did','does','only','want','would']);
export function selectMemories(rows, query) {
  const question = String(query || '').toLowerCase();
  const words = question.match(/[a-z]{3,}/g)?.filter(word => !queryStopWords.has(word)) || [];
  const explicitRecall = /\b(?:remember|memory|memories)\b|what (?:do you know|did i tell you) about me/i.test(question);
  return (Array.isArray(rows) ? rows : []).filter(r => r && r.active !== false && !r.archivedAt && (!r.status || r.status === 'active') && typeof r.text === 'string').map(r => {
    const fact = r.text.toLowerCase();
    const tokens = new Set(fact.match(/[a-z]{3,}/g) || []);
    const shared = words.reduce((n, word) => n + (tokens.has(word) ? 1 : 0), 0);
    const domain = memoryDomains.some(d => d.fact.test(fact) && d.query.test(question));
    return {r, score: explicitRecall ? 1 : shared + (domain ? 2 : 0)};
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, explicitRecall ? 20 : 6).map(({r}) => ({
    text: r.text.slice(0, 400),
    category: safeText(r.category, 40) || 'preference',
    updatedAt: isoDay(r.updatedAt) || isoDay(r.createdAt)
  }));
}
export async function saveMemory(repo, input, signal) {
  const candidate = memoryCandidate(input);
  if (!candidate) throw Object.assign(new Error('Only lasting preferences or routines can be remembered.'), {
    code: 'MEMORY_NOT_DURABLE'
  });
  const prefs = await repo.preferences();
  const canonical = [prefs.notesForCoach, prefs.constraints, prefs.injuries, prefs.trainingBackground].filter(v => typeof v === 'string').map(v => clean(v).toLowerCase().replace(/[.!]+$/, ''));
  if (canonical.includes(candidate.text.toLowerCase().replace(/[.!]+$/, ''))) throw Object.assign(new Error('Already represented in your profile.'), {
    code: 'MEMORY_CANONICAL'
  });
  const memories = await repo.memories();
  const conflicts = memories.filter(row => row.active !== false && (row.key || memoryCandidate(row.text)?.key) === candidate.key);
  if (signal?.aborted) throw Error("Cancelled");
  return repo.updateMemory(candidate, conflicts);
}
