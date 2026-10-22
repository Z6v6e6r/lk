// Keep real driver acknowledgements/CAS counts; never infer completion from a read.
// Supports driver 3.7.4 already shipped by node-red-node-mongodb and modern drivers.
export function compatibleDatabase(database) {
  const normalise = result => {
    const modern = typeof result?.acknowledged === 'boolean';
    if (!modern && result?.result?.ok !== 1) throw new Error('mongo_ack_missing');
    return { acknowledged: modern ? result.acknowledged : true,
      matchedCount: result.matchedCount, modifiedCount: result.modifiedCount, deletedCount: result.deletedCount };
  };
  return {
    collection(name) {
      const collection = database.collection(name);
      return {
        findOne: (...args) => collection.findOne(...args),
        createIndex: (...args) => collection.createIndex(...args),
        countDocuments: (...args) => collection.countDocuments(...args),
        aggregate: (...args) => collection.aggregate(...args),
        insertOne: async (...args) => normalise(await collection.insertOne(...args)),
        updateOne: async (...args) => normalise(await collection.updateOne(...args)),
        updateMany: async (...args) => normalise(await collection.updateMany(...args)),
        deleteOne: async (...args) => normalise(await collection.deleteOne(...args)),
        async findOneAndUpdate(filter,update,options) {
          const claimOptions = { ...options, returnDocument: 'after', includeResultMetadata: false };
          // 3.x rejects supplying both the old and new option names, even if equivalent.
          delete claimOptions.returnOriginal;
          const result = await collection.findOneAndUpdate(filter,update,claimOptions);
          // Modern drivers return the document directly; 3.x returns {value,ok,...}.
          if (result === null || result?._id !== undefined) return result;
          if (result?.ok === 1 && Object.hasOwn(result,'value') &&
            (result.value === null || result.value?._id !== undefined)) return result.value;
          throw new Error('claim_not_confirmed');
        }
      };
    }
  };
}
