#!/usr/bin/env node

/**
 * This script gathers dates and payload names from the subreddit launch manifest,
 * fuzzy checks them against existing upcoming payload id's and updates the date if a
 * change is made in the wiki. The proper time zone is calculated from the launch site
 * id of the launch. It also updates the flight number order based on the launch manifest order.
 *
 * Hopefully the format of the wiki does not change, but there's no real reason for it to change in the
 * forseeable future. If it does change, this script will have to be updated as necessary.
 */

const MongoClient = require('mongodb');
const moment = require('moment-timezone');
const cheerio = require('cheerio');
const request = require('request-promise-native');
const fuzz = require('fuzzball');

let client;
let location;
let calculatedTimes;
let localTime;
let date;
let tbd;
let is_tentative;

const sites = [];
const payloads = [];
const promises = [];
const precision = [];
const flight_numbers = [];

// RegEx expressions for matching dates in the wiki manifest
// Allows for long months or short months ex. September vs Sep
// Allows for time with or without brackets ex [23:45] vs 23:45
const hour = /^[0-9]{4}\s([a-z]{3}|[a-z]{3,9})\s[0-9]{1,2}\s(\[[0-9]{2}:[0-9]{2}\]|[0-9]{2}:[0-9]{2})$/i;
const day = /^[0-9]{4}\s([a-z]{3}|[a-z]{3,9})\s[0-9]{1,2}$/i;
const month = /^[0-9]{4}\s([a-z]{3}|[a-z]{3,9})$/i;
const year = /^[0-9]{4}$/i;

// Separate Regex for TBD times and dates
const year_tbd = /^[0-9]{4}\sTBD$/i;
const month_tbd = /^[0-9]{4}\s([a-z]{3}|[a-z]{3,9})\sTBD$/i;

// Separate Regex for Early, Mid, and Late
const month_vague = /^[0-9]{4}\s(early|mid|late)\s([a-z]{3}|[a-z]{3,9})$/i;

// Using async IIFE to allow "top" level await
(async () => {
  try {
    client = await MongoClient.connect(process.env.MONGO_URL, { useNewUrlParser: true });
  } catch (err) {
    console.log(err.stack);
  }

  const col = client.db('spacex-api').collection('launch');

  const launches = await col.find({ upcoming: true }).sort({ flight_number: 1 }).toArray();

  // We need the most recent launch number to keep all upcoming launches
  // in the correct order
  const past_launches = await col.find({ upcoming: false }).sort({ flight_number: -1 }).toArray();
  const base_flight_number = past_launches[0].flight_number + 1;

  // Collect site names for time zone and payload name for fuzzy check
  launches.forEach(launch => {
    payloads.push(launch.rocket.second_stage.payloads[0].payload_id);
    sites.push(launch.launch_site.site_id);
  });

  // Grab subreddit wiki manifest
  const result = await request('https://www.reddit.com/r/spacex/wiki/launches/manifest');
  const $ = cheerio.load(result);

  // Gives us all manifest table rows in a single array
  const manifest = $('body > div.content > div > div > table:nth-child(6) > tbody').text();
  const manifest_row = manifest.split('\n').filter(v => v !== '');

  // Filter to collect manifest dates
  const manifest_dates = manifest_row.filter((value, index) => index % 8 === 0);

  // Filter to collect payload names
  const manifest_payloads = manifest_row.filter((value, index) => (index + 3) % 8 === 0);

  // Filter to collect launchpad names
  const manifest_launchpads = manifest_row.filter((value, index) => (index + 6) % 8 === 0);

  // Compare each payload against entire list of manifest payloads, and fuzzy match the
  // payload id against the manifest payload name. The partial match must be 100%, to avoid
  // conflicts like SSO-A and SSO-B, where a really close match would produce wrong results.
  payloads.forEach((payload, payload_index) => {
    manifest_payloads.forEach((manifest_payload, manifest_index) => {
      if (fuzz.partial_ratio(payload, manifest_payload) === 100) {
        // Check and see if dates match a certain patten depending on the length of the
        // date given. This sets the amount of precision needed for the date.
        let mdate = manifest_dates[manifest_index];
        // 2020 Q3
        if (mdate.includes('Q')) {
          mdate = mdate.replace('Q', '');
          precision[manifest_index] = 'quarter';
          tbd = true;
          is_tentative = true;
          // 2020 H1
        } else if (mdate.includes('H1')) {
          mdate = mdate.replace('H1', '1');
          precision[manifest_index] = 'half';
          tbd = true;
          is_tentative = true;
          // 2020 H2
        } else if (mdate.includes('H2')) {
          mdate = mdate.replace('H2', '3');
          precision[manifest_index] = 'half';
          tbd = true;
          is_tentative = true;
          // 2020 TBD
        } else if (year_tbd.test(mdate)) {
          precision[manifest_index] = 'year';
          tbd = true;
          is_tentative = true;
          // 2020
        } else if (year.test(mdate)) {
          precision[manifest_index] = 'year';
          tbd = true;
          is_tentative = true;
          // 2020 Nov TBD
        } else if (month_tbd.test(mdate)) {
          precision[manifest_index] = 'month';
          tbd = true;
          is_tentative = true;
          // 2020 Early/Mid/Late Nov
        } else if (month_vague.test(mdate)) {
          precision[manifest_index] = 'month';
          tbd = true;
          is_tentative = true;
          // 2020 Nov
        } else if (month.test(mdate)) {
          precision[manifest_index] = 'month';
          tbd = true;
          is_tentative = true;
          // 2020 Nov 4
        } else if (day.test(mdate)) {
          precision[manifest_index] = 'day';
          tbd = false;
          is_tentative = true;
          // 2020 Nov 4 [14:10]
        } else if (hour.test(mdate)) {
          precision[manifest_index] = 'hour';
          tbd = false;
          is_tentative = false;
        } else {
          console.log('Date did not match any of the existing regular expressions');
          return;
        }

        // Store site_id for update query
        // Store manifest date for data cleaning
        location = sites[payload_index];
        date = manifest_dates[manifest_index];

        console.log(date);
        console.log(`${payload} : ${manifest_payload}`);

        // Strip brackets from time given, and tack on UTC time offset at the end for date parser
        const parsed_date = `${date.replace(/(early|mid|late)/i, '').replace('[', '').replace(']', '')} +0000`;
        const time = moment(parsed_date, ['YYYY MMM D HH:mm Z', 'YYYY MMM D Z', 'YYYY MMM Z', 'YYYY Q Z', 'YYYY Z']);

        // Feed stripped time into all possible date formats in the wiki currently
        const zone = moment.tz(time, 'UTC');

        // Use launch site id's to properly set timezone for local time
        if (location === 'ccafs_slc_40' || location === 'ksc_lc_39a' || location === 'ccafs_lc_13') {
          localTime = time.tz('America/New_York').format();
        } else if (location === 'vafb_slc_4e' || location === 'vafb_slc_4w') {
          localTime = time.tz('America/Los_Angeles').format();
        } else {
          localTime = time.tz('America/Chicago').format();
        }

        // Add flight numbers to array to check for duplicates
        flight_numbers.push(base_flight_number + manifest_index);

        // Calculate launch site depending on wiki manifest
        let site_id = null;
        let site_name = null;
        let site_name_long = null;
        console.log(manifest_launchpads[manifest_index]);

        if (manifest_launchpads[manifest_index] === 'SLC-40' || manifest_launchpads[manifest_index] === 'SLC-40 / LC-39A' || manifest_launchpads[manifest_index] === 'SLC-40 / BC') {
          site_id = 'ccafs_slc_40';
          site_name = 'CCAFS SLC 40';
          site_name_long = 'Cape Canaveral Air Force Station Space Launch Complex 40';
        } else if (manifest_launchpads[manifest_index] === 'LC-39A' || manifest_launchpads[manifest_index] === 'LC-39A / BC' || manifest_launchpads[manifest_index] === 'LC-39A / SLC-40') {
          site_id = 'ksc_lc_39a';
          site_name = 'KSC LC 39A';
          site_name_long = 'Kennedy Space Center Historic Launch Complex 39A';
        } else if (manifest_launchpads[manifest_index] === 'SLC-4E') {
          site_id = 'vafb_slc_4e';
          site_name = 'VAFB SLC 4E';
          site_name_long = 'Vandenberg Air Force Base Space Launch Complex 4E';
        } else if (manifest_launchpads[manifest_index] === 'BC' || manifest_launchpads[manifest_index] === 'BC / LC-39A' || manifest_launchpads[manifest_index] === 'BC / SLC-40') {
          site_id = 'stls';
          site_name = 'STLS';
          site_name_long = 'SpaceX South Texas Launch Site';
        }

        // Build launch time objects to update
        calculatedTimes = {
          flight_number: (base_flight_number + manifest_index),
          launch_year: (zone.year()).toString(),
          launch_date_unix: zone.unix(),
          launch_date_utc: zone.toISOString(),
          launch_date_local: localTime,
          is_tentative,
          tentative_max_precision: precision[manifest_index],
          tbd,
          'launch_site.site_id': site_id,
          'launch_site.site_name': site_name,
          'launch_site.site_name_long': site_name_long,

        };
        console.log(calculatedTimes);
        console.log('');

        // Add to array of promises to update all at once after the forEach iterations finish
        promises.push(col.updateOne({ 'rocket.second_stage.payloads.payload_id': payload }, { $set: calculatedTimes }));
      }
    });
  });

  // Check if duplicate flight numbers exist
  if ([...new Set(flight_numbers)].length < flight_numbers.length) {
    console.log('Duplicate flight numbers found');
    process.exit(1);
  }

  // Execute all our stored update promises
  const output = await Promise.all(promises);

  // Display if the document was found, and if it was modified or not
  output.forEach((doc, index) => {
    if (doc.result.nModified !== 0) {
      console.log(`${payloads[index]} UPDATED`);
    } else {
      console.log(`${payloads[index]}`);
    }
  });

  if (client) {
    client.close();
  }
})();
