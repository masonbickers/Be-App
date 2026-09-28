// Compatibility repository for the deployed legacy Coach API. Every reference
// is rooted in verified server identity, never a UID or path from the request.
export function createLegacyMemoryRepository(db, uid, signal) {
  if (!uid || typeof uid !== 'string' || uid.includes('/')) throw new Error('Authenticated user required');
  const root = db.collection('users').doc(uid);
  return {
    async preferences() { return (await root.collection('planPrefs').doc('current').get()).data() || {}; },
    async memories() {
      if ((await root.collection('coachSettings').doc('current').get()).data()?.savedPreferences === false) return [];
      const col = root.collection('coachMemory');
      const pages = await Promise.all([col.orderBy('updatedAt','desc').limit(100).get(), col.orderBy('createdAt','desc').limit(100).get()]);
      const stamp = row => row.updatedAt?.toMillis?.() || row.createdAt?.toMillis?.() || Date.parse(row.updatedAt || row.createdAt) || 0;
      return [...new Map(pages.flatMap(page => page.docs).map(doc => [doc.id,{...doc.data(),_id:doc.id}])).values()]
        .filter(row => row.active !== false && !row.archivedAt).sort((a,b) => stamp(b)-stamp(a)).slice(0,100);
    },
    async updateMemory(candidate, conflicts) {
      const ref = root.collection('coachMemory').doc('v2_' + candidate.key.replace(/[^a-z0-9_.-]/gi,'_'));
      return db.runTransaction(async tx => {
        const settings = await tx.get(root.collection('coachSettings').doc('current'));
        if (settings.data()?.savedPreferences === false) throw Object.assign(new Error('Saved preferences are disabled'), {code:'MEMORY_DISABLED'});
        if (signal?.aborted) throw new Error('Cancelled');
        const old = await tx.get(ref), previous = old.exists ? old.data() : null;
        if (signal?.aborted) throw new Error('Cancelled');
        const now = new Date(), version = Math.max(1,(previous?.version || 0)+(previous?.text===candidate.text?0:1));
        tx.set(ref,{...candidate,active:true,source:'coach_chat',version,createdAt:previous?.createdAt || now,updatedAt:now});
        for (const row of conflicts) if (row._id && row._id !== ref.id) tx.set(root.collection('coachMemory').doc(row._id),{active:false,supersededBy:ref.id,updatedAt:now},{merge:true});
        return {saved:true,version};
      });
    },
  };
}
export async function legacyMemoryRepositoryForUser(uid, signal) {
  const {default:admin} = await import('../../admin.js');
  return createLegacyMemoryRepository(admin.firestore(),uid,signal);
}
