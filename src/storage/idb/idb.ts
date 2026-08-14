// src/idb/idb.ts
import Dexie from 'dexie';
import { IdbSample } from '@/types/Sample';

export class AudioSampleDB extends Dexie {
  samples: Dexie.Table<IdbSample, TODO>; //

  constructor() {
    super('AudioSampleDB');

    // Define the schema for the database
    this.version(1).stores({
      samples: 'id, url, dateAdded, isDefaultInitSample, isFromDefaultLib',
    });

    this.samples = this.table('samples');
  }
}

// Singleton instance
export const idb = new AudioSampleDB();
