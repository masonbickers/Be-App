// Bounded Firestore fake for store and HTTP integration tests.
export function fakeDb() {
  const data = new Map();
  const snapshot = (ref) => ({ id: ref.id, ref, exists: data.has(ref.path), data: () => structuredClone(data.get(ref.path)) });
  function collection(path, filters = [], orders = [], max = Infinity, after = null) {
    return { path,
      doc: id => document(`${path}/${id}`),
      where: (field, op, value) => collection(path, [...filters, [field, op, value]], orders, max, after),
      orderBy: (field, dir = 'asc') => collection(path, filters, [...orders, [field, dir]], max, after),
      select: () => collection(path, filters, orders, max, after),
      limit: cap => collection(path, filters, orders, cap, after),
      findNearest: () => collection(path, filters, orders, 12, after),
      startAfter: (...values) => collection(path, filters, orders, max, values),
      async get() {
        let rows = [...data.entries()].filter(([key]) => key.startsWith(path + '/') && key.split('/').length === path.split('/').length + 1);
        rows = rows.filter(([, row]) => filters.every(([field, op, value]) => op === '==' ? row[field] === value : op === '<' ? row[field] < value : op === '>' ? row[field] > value : row[field] <= value));
        const compare = (a, b) => {
          const normalize = value => value instanceof Date ? value.getTime() : value?.toMillis ? value.toMillis() : value?.path || value;
          a = normalize(a); b = normalize(b);
          return a < b ? -1 : a > b ? 1 : 0;
        };
        const fieldValue = (row, field) => typeof field === 'string' ? row[1][field] : row[0];
        const compareOrdered = (row, values) => {
          for (let i = 0; i < orders.length; i++) {
            const result = compare(fieldValue(row, orders[i][0]), values[i]) * (orders[i][1] === 'desc' ? -1 : 1);
            if (result) return result;
          }
          return 0;
        };
        rows.sort((a, b) => compareOrdered(a, orders.map(([field]) => fieldValue(b, field))));
        if (after) rows = rows.filter(row => compareOrdered(row, after) > 0);
        const docs = rows.slice(0, max).map(([key]) => snapshot(document(key)));
        return { docs, size: docs.length };
      },
    };
  }
  function document(path) { return {
    path, id: path.split('/').at(-1), collection: name => collection(`${path}/${name}`),
    get: async () => snapshot(document(path)),
    set: async (value, options) => data.set(path, options?.merge ? { ...data.get(path), ...structuredClone(value) } : structuredClone(value)),
    update: async patch => data.set(path, { ...data.get(path), ...structuredClone(patch) }),
    delete: async () => data.delete(path),
  }; }
  let queue = Promise.resolve();
  return { data, collection, doc: document, runTransaction(fn) {
    const run = queue.then(async () => {
      const writes = [], tx = { get: ref => ref.get(), set: (ref, value) => writes.push(() => data.set(ref.path, structuredClone(value))), update: (ref, patch) => writes.push(() => data.set(ref.path, { ...data.get(ref.path), ...structuredClone(patch) })), delete: ref => writes.push(() => data.delete(ref.path)) };
      const result = await fn(tx);
      writes.forEach(write => write());
      return result;
    });
    queue = run.catch(() => {});
    return run;
  } };
}
