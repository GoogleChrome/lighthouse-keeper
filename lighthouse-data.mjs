/**
 * Copyright 2018 Google Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import fs from 'fs';
import Firestore from '@google-cloud/firestore';
import Storage from '@google-cloud/storage';
import ReportGenerator from 'lighthouse/lighthouse-core/report/report-generator.js';
import Memcache from './memcache.mjs';
import LighthouseAPI from './lighthouse-api.mjs';

const SERVICE_ACCOUNT_FILE = './serviceAccount.json';
const STORAGE_BUCKET = 'webdotdevsite.appspot.com';
const serviceAccountJSON = JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_FILE));

const MAX_REPORTS = 10;

function slugify(url) {
  return url.replace(/\//g, '__');
}

function deslugify(id) {
  return id.replace(/__/g, '/');
}

/**
 * The "median" is the "middle" value in the list of numbers.
 * @param {!Array<number>} numbers An array of numbers.
 * @return {number} The calculated median value from the specified numbers.
 */
function median(numbers) {
  // median of [3, 5, 4, 4, 1, 1, 2, 3] = 3
  let median = 0
  numbers.sort();
  if (numbers.length % 2 === 0) {  // is even
    // average of two middle numbers
    median = (numbers[numbers.length / 2 - 1] + numbers[numbers.length / 2]) / 2;
  } else { // is odd
    // middle number only
    median = numbers[(numbers.length - 1) / 2];
  }
  return median;
}

/**
 * Uploads the LH report to Firebase cloud storage.
 * @param {!Object} lhr Full lhr object
 * @param {string} name Report name.
 * @return {!Promise<undefined>}
 * @export
 */
async function uploadReport(lhr, name) {
  const bucket = storage.bucket(STORAGE_BUCKET);
  const filename = `lhrs/${name}.json`;
  return await bucket.file(filename).save(JSON.stringify(lhr), {
    gzip: true,
    resumable: false
  });
}

/**
 * Dwonloads the full LH report from Firebase cloud storage.
 * @param {string} url Target url for the report.
 * @return {Object} Json with lhr data.
 * @export
 */
export async function getFullReport(url) {
  const bucket = storage.bucket(STORAGE_BUCKET);
  const filename = `lhrs/${slugify(url)}.json`;
  const data = await bucket.file(filename).download();
  return JSON.parse(data);
}

/**
 * Saves Lighthouse report to Firestore.
 * @param {string} url URL to save run under.
 * @param {!Object} json
 * @param {boolean} replace If true, replaces the last saved report with this
 *     new result. False, saves a new report.
 * @return {!Promise<!Object>}
 * @export
 */
export async function saveReport(url, json, replace) {
  const lhr = json.lhr;

  delete lhr.i18n; // remove cruft we don't to store.

  // Trim down the LH results to only include category/scores.
  const categories = JSON.parse(JSON.stringify(lhr.categories)); // clone it.
  const lhrSlim = Object.values(categories).map(cat => {
    delete cat.auditRefs;
    return cat;
  });

  const today = new Date();
  const data = {
    lhrSlim,
    auditedOn: today,
  };

  if (Object.keys(json.crux).length) {
    data.crux = json.crux;
  }

  const collectionRef = db.collection(slugify(url));
  const querySnapshot = await collectionRef
      .orderBy('auditedOn', 'desc').limit(1).get();

  const lastDoc = querySnapshot.docs[0];

  // New URL added to system. Delete cached list.
  if (!lastDoc) {
    await memcache.delete('getAllSavedUrls');
  }

  lhr.auditedOn = today;
  await uploadReport(lhr, slugify(url));
  if (replace && lastDoc) {
    await lastDoc.ref.update(data); // Replace last entry with updated vals.
  } else {
    await collectionRef.add(data); // Add new report.
  }

  await updateLastViewed(url);
  // Clear relevant caches.
  await Promise.all([
    memcache.delete(`getReports_${slugify(url)}`),
    memcache.delete('getMedianScoresOfAllUrls'),
  ]);

  return data;
}

/**
 * Returns urls with lastViewed date older than cutoff date.
 * @param {Date} cutoffDate Date before which urls are considered stale.
 * @return {!Array<string>}
 * @export
 */
export async function getUrlsLastViewedBefore(cutoffDate) {
  const metaCollection = db.collection('meta');
  const staleUrls = [];
  await metaCollection
      .where('lastViewed', '<', cutoffDate)
      .get()
      .then(snapshot => snapshot.forEach(doc => {
        staleUrls.push(doc.id);
      }));
  return staleUrls;
}

/**
 * Audits a site using the Lighthouse API.
 * @param {string} url Url to audit.
 * @param {boolean=} replace If true, replaces the last saved report with this
 *     new result. False, saves a new report. Defaults to true.
 * @return {!Object} API response.
 * @export
 */
export async function runLighthouseAPI(url, replace=true) {
  const api = new LighthouseAPI(serviceAccountJSON.PSI_API_KEY);

  let json = {};
  try {
    json = await api.audit(url);

    // https://github.com/GoogleChrome/lighthouse/issues/6336
    if (json.lhr.runtimeError && json.lhr.runtimeError.code !== 'NO_ERROR') {
      throw new Error(
          `${json.lhr.runtimeError.code} ${json.lhr.runtimeError.message}`);
    }

    json = await saveReport(url, json, replace);
  } catch (err) {
    console.log(err);
    json.errors = `${err}`;
  }

  return json;
}

/**
 * Returns all the URLs stored in the system.
 * @param {{useCache: boolean=}} Config object.
 * @return {!Promise<string>}
 * @export
 */
export async function getAllSavedUrls({useCache}={useCache: true}) {
  const val = await memcache.get('getAllSavedUrls');
  if (val && useCache) {
    return val;
  }

  const collections = await db.getCollections();
  const urls = collections.filter(c => c.id.startsWith('http'))
      .map(c => deslugify(c.id)).sort();

  await memcache.set('getAllSavedUrls', urls);

  return urls;
}

/**
 *  Updates the last viewed metadata for a URL.
 * @param {string} url
 * @return {!Promise}
 */
async function updateLastViewed(url) {
  return db.doc(`meta/${slugify(url)}`).set({lastViewed: new Date()});
}

/**
 * Returns all saved scores, per category.
 * @param {string} url
 * @param {number=} maxResults Max number of reports to return. Defaults to
 *     MAX_REPORTS.
 * @return {!Promise<!Object>}
 */
async function getAllScores(url, maxResults=MAX_REPORTS) {
  const querySnapshot = await db.collection(`${slugify(url)}`)
      .orderBy('auditedOn', 'desc').limit(maxResults).get();

  const runs = querySnapshot.docs;
  runs.reverse(); // Order reports from oldest -> most recent.

  const scores = {};
  runs.map(doc => {
    doc.get('lhrSlim').forEach(cat => {
      if (!scores[cat.id]) {
        scores[cat.id] = [];
      }
      scores[cat.id].push(cat.score * 100);
    });
  });

  return scores;
}

/**
 *  Updates the last viewed metadata for a URL.
 * @param {string} url
 * @param {number=} maxResults Max number of reports to return. Defaults to
 *     MAX_REPORTS.
 * @return {!Promise}
 * @export
 */
export async function getMedianScores(url, maxResults=MAX_REPORTS) {
  const scores = await getAllScores(url, maxResults);

  // Calculate medians
  const medians = {};
  Object.entries(scores).map(([cat, scores]) => {
    medians[cat] = median(scores);
  });

  return medians;
}

/**
 *  Updates the last viewed metadata for a URL.
 * @param {{maxResults: number=, useCache: boolean=}} Config object.
 * @return {!Promise<!Object>}
 * @export
 */
export async function getMedianScoresOfAllUrls(
    {maxResults, useCache}={maxResults: MAX_REPORTS, useCache: true}) {
  const val = await memcache.get('getMedianScoresOfAllUrls');
  if (val && useCache) {
    return val;
  }

  const combinedScores = {};

  const urls = await getAllSavedUrls();
  for (const url of urls) {
    const urlScores = await getAllScores(url, maxResults);
    Object.entries(urlScores).map(([cat, scores]) => {
      if (!combinedScores[cat]) {
        combinedScores[cat] = [];
      }
      combinedScores[cat].push(...scores);
    });
  }

  // Calculate medians
  const medians = {};
  Object.entries(combinedScores).map(([cat, scores]) => {
    medians[cat] = median(scores);
  });

  if (useCache) {
    await memcache.set('getMedianScoresOfAllUrls', medians);
  }

  return medians;
}

/**
 * Get saved reports for a given URL.
 * @param {string} url URL to fetch reports for.
 * @param {{maxResults: number=, useCache: boolean=}}
 *     Config object.
 * @param {boolean=} useCache If false, bypasses cache. Defaults to true.
 * @return {!Array<Object>|null} The reports.
 * @export
 */
export async function getReports(url,
    {maxResults, useCache}={maxResults: MAX_REPORTS, useCache: true}) {
  const cacheKey = `getReports_${slugify(url)}`;
  const val = await memcache.get(cacheKey);
  if (val && useCache) {
    await updateLastViewed(url); // "touch" last viewed timestamp for URL.
    return val;
  }

  const querySnapshot = await db.collection(slugify(url))
      .orderBy('auditedOn', 'desc').limit(maxResults).get();

  let runs = [];

  if (querySnapshot.empty) {
    return runs;
  } else {
    querySnapshot.forEach(doc => runs.push(doc.data()));
    runs.reverse(); // Order reports from oldest -> most recent.
    await updateLastViewed(url); // "touch" url's last viewed date.
  }

  const lhr = await getFullReport(url);
  runs = runs.map(r => {
    const ts = new Firestore.Timestamp(
        r.auditedOn._seconds, r.auditedOn._nanoseconds);
    r.auditedOn = ts.toDate();
    if (r.auditedOn.toISOString() === lhr.auditedOn) {
      r.lhr = lhr;
    }
    return r;
  });

  if (useCache) {
    await memcache.set(cacheKey, runs);
  }

  return runs;
}

/**
 * Deletes a subcollection in Firestore by batch.
 * @param {!Object} query Firestore subcollection query.
 * @param {!Function} resolve Function to call when all batches are deleted.
 * @param {!Function} reject Function to call in case of error.
 */
function deleteBatch_(query, resolve, reject) {
  query.get().then((snapshot) => {
      if (snapshot.size === 0) {
        return 0;
      }
      const batch = db.batch();
      snapshot.docs.forEach((doc) => {
        batch.delete(doc.ref);
      });
      return batch.commit().then(() => snapshot.size);
    }).then((numDeleted) => {
      if (numDeleted === 0) {
        resolve();
        return;
      }
      // Recurse on the next process tick, to avoid
      // exploding the stack.
      // @see https://firebase.google.com/docs/firestore/manage-data/delete-data
      process.nextTick(() => {
        deleteBatch_(query, resolve, reject);
      });
    })
    .catch(reject);
}

/**
 * Deletes all saved reports for a given URL.
 * @param {string} url URL to fetch reports for.
 * @return {!Promise<undefined>}
 * @export
 */
export async function deleteReports(url) {
  const batchSize = 20;
  const collectionRef = db.collection(slugify(url));
  const query = collectionRef.orderBy('__name__').limit(batchSize);

  return new Promise((resolve, reject) => {
    deleteBatch_(query, resolve, reject);
  });
}

/**
 * Deletes url metadata.
 * @param {string} url
 * @return {!Promise}
 * @export
 */
export async function deleteMetadata(url) {
  return db.collection('meta').doc(slugify(url)).delete();
}

/**
 * Generates a LH report in different formats.
 * @param {!Object} lhr Lighthouse report object.
 * @param {string} format How to format the report. One 'html', 'json', 'csv'.
 * @return {string} Report.
 * @export
 */
export function generateReport(lhr, format) {
  return ReportGenerator.generateReport(lhr, format);
}

const db = new Firestore({
  projectId: serviceAccountJSON.project_id,
  keyFilename: SERVICE_ACCOUNT_FILE,
  timestampsInSnapshots: true,
});

const memcache = new Memcache();

const storage = new Storage.Storage({
  projectId: serviceAccountJSON.project_id,
  keyFilename: SERVICE_ACCOUNT_FILE
});
