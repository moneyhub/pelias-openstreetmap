const { parseCSV } = require('./csvParser');
const { queryElasticsearch, normalizePostcode, ELASTICSEARCH_HOST, ELASTICSEARCH_PORT, INDEX_NAME } = require('./elasticsearch');

async function evaluatePostcodes(csvPath, debug = false, filterRegion = '') {
  console.log('Reading CSV file...');
  if (filterRegion) {
    console.log(`Filtering by region: "${filterRegion}"`);
  }
  const records = parseCSV(csvPath, debug, filterRegion);
  console.log(`Found ${records.length} records to evaluate\n`);

  let totalRecords = records.length;
  let recordsWithResults = 0;
  let recordsWithPostcode = 0;
  let correctMatches = 0;
  let noResults = [];
  let missingPostcodes = [];
  let mismatches = [];

  if (debug) {
    console.log(`[DEBUG] Elasticsearch connection: ${ELASTICSEARCH_HOST}:${ELASTICSEARCH_PORT}`);
    console.log(`[DEBUG] Index: ${INDEX_NAME}\n`);
  }

  console.log('Querying Elasticsearch for each record...\n');

  let debugSampleCount = 0;
  const MAX_DEBUG_SAMPLES = 5;

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const { latitude, longitude, ground_truth_postcode } = record;

    try {
      const queryResult = await queryElasticsearch(latitude, longitude, debug);
      const result = debug ? queryResult.source : queryResult;

      if (!result) {
        const debugInfo = debug ? {
          totalHits: queryResult.totalHits,
          fullResponse: queryResult.fullResponse
        } : null;
        noResults.push({ 
          lat: latitude, 
          lon: longitude, 
          expected: ground_truth_postcode,
          debugInfo: debugInfo
        });
        
        if (debug && debugSampleCount < MAX_DEBUG_SAMPLES) {
          console.log(`\n[DEBUG] Sample ${debugSampleCount + 1} - NO RESULTS:`);
          console.log(`  Query: lat=${latitude}, lon=${longitude}, expected="${ground_truth_postcode}"`);
          console.log(`  Total hits: ${queryResult.totalHits}`);
          if (queryResult.fullResponse) {
            console.log(`  Response structure:`, JSON.stringify({
              took: queryResult.fullResponse.took,
              timed_out: queryResult.fullResponse.timed_out,
              hits: {
                total: queryResult.fullResponse.hits?.total,
                max_score: queryResult.fullResponse.hits?.max_score,
                hits_count: queryResult.fullResponse.hits?.hits?.length || 0
              }
            }, null, 2));
          }
          debugSampleCount++;
        }
        continue;
      }

      recordsWithResults++;

      const returnedPostcode = result.address_parts?.zip || null;

      if (!returnedPostcode) {
        missingPostcodes.push({
          lat: latitude,
          lon: longitude,
          expected: ground_truth_postcode,
          name: result.name?.default || 'Unknown',
          layer: result.layer || 'unknown',
          source: result.source || 'unknown',
          addressParts: result.address_parts || {}
        });
        
        if (debug && debugSampleCount < MAX_DEBUG_SAMPLES) {
          console.log(`\n[DEBUG] Sample ${debugSampleCount + 1} - MISSING POSTCODE:`);
          console.log(`  Query: lat=${latitude}, lon=${longitude}, expected="${ground_truth_postcode}"`);
          console.log(`  Result name: ${result.name?.default || 'N/A'}`);
          console.log(`  Result layer: ${result.layer || 'N/A'}`);
          console.log(`  Result source: ${result.source || 'N/A'}`);
          console.log(`  Address parts:`, JSON.stringify(result.address_parts || {}, null, 2));
          console.log(`  Full result (keys):`, Object.keys(result));
          debugSampleCount++;
        }
        continue;
      }

      recordsWithPostcode++;

      const normalizedExpected = normalizePostcode(ground_truth_postcode);
      const normalizedReturned = normalizePostcode(returnedPostcode);

      if (normalizedExpected === normalizedReturned) {
        correctMatches++;
      } else {
        mismatches.push({
          lat: latitude,
          lon: longitude,
          expected: ground_truth_postcode,
          returned: returnedPostcode,
          normalizedExpected: normalizedExpected,
          normalizedReturned: normalizedReturned,
          name: result.name?.default || 'Unknown'
        });
        
        if (debug && debugSampleCount < MAX_DEBUG_SAMPLES) {
          console.log(`\n[DEBUG] Sample ${debugSampleCount + 1} - MISMATCH:`);
          console.log(`  Query: lat=${latitude}, lon=${longitude}`);
          console.log(`  Expected: "${ground_truth_postcode}" (normalized: "${normalizedExpected}")`);
          console.log(`  Returned: "${returnedPostcode}" (normalized: "${normalizedReturned}")`);
          console.log(`  Result name: ${result.name?.default || 'N/A'}`);
          debugSampleCount++;
        }
      }

      if ((i + 1) % 100 === 0) {
        console.log(`Processed ${i + 1}/${totalRecords} records...`);
      }
    } catch (error) {
      console.error(`Error processing record ${i + 1}:`, error.message);
      if (debug) {
        console.error(`  Full error:`, error);
      }
      noResults.push({ lat: latitude, lon: longitude, expected: ground_truth_postcode });
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('EVALUATION RESULTS');
  console.log('='.repeat(60));

  console.log(`\nTotal records: ${totalRecords}`);
  console.log(`Records with results: ${recordsWithResults}`);
  console.log(`Records with postcode: ${recordsWithPostcode}`);
  console.log(`Correct matches: ${correctMatches}`);

  const precision = recordsWithPostcode > 0 ? (correctMatches / recordsWithPostcode) * 100 : 0;
  const accuracy = totalRecords > 0 ? (correctMatches / totalRecords) * 100 : 0;
  const coverage = totalRecords > 0 ? (recordsWithPostcode / totalRecords) * 100 : 0;

  console.log('\n' + '-'.repeat(60));
  console.log('METRICS');
  console.log('-'.repeat(60));
  console.log(`Precision: ${precision.toFixed(2)}% (${correctMatches}/${recordsWithPostcode})`);
  console.log(`Accuracy:  ${accuracy.toFixed(2)}% (${correctMatches}/${totalRecords})`);
  console.log(`Coverage:  ${coverage.toFixed(2)}% (${recordsWithPostcode}/${totalRecords})`);

  if (noResults.length > 0) {
    console.log('\n' + '-'.repeat(60));
    console.log(`NO RESULTS FOUND (${noResults.length} records):`);
    console.log('-'.repeat(60));
    noResults.slice(0, 10).forEach((r, idx) => {
      console.log(`${idx + 1}. Lat: ${r.lat}, Lon: ${r.lon}, Expected: ${r.expected}`);
    });
    if (noResults.length > 10) {
      console.log(`... and ${noResults.length - 10} more`);
    }
  }

  if (missingPostcodes.length > 0) {
    console.log('\n' + '-'.repeat(60));
    console.log(`MISSING POSTCODES (${missingPostcodes.length} records):`);
    console.log('-'.repeat(60));
    missingPostcodes.slice(0, 10).forEach((r, idx) => {
      console.log(`${idx + 1}. Lat: ${r.lat}, Lon: ${r.lon}, Name: ${r.name}, Expected: ${r.expected}`);
      if (debug && idx < 3) {
        console.log(`    Layer: ${r.layer}, Source: ${r.source}`);
        console.log(`    Address parts:`, JSON.stringify(r.addressParts, null, 4));
      }
    });
    if (missingPostcodes.length > 10) {
      console.log(`... and ${missingPostcodes.length - 10} more`);
    }
  }

  if (mismatches.length > 0) {
    console.log('\n' + '-'.repeat(60));
    console.log(`MISMATCHES (${mismatches.length} records):`);
    console.log('-'.repeat(60));
    mismatches.slice(0, 10).forEach((r, idx) => {
      console.log(`${idx + 1}. Lat: ${r.lat}, Lon: ${r.lon}`);
      console.log(`    Expected: "${r.expected}" → "${r.normalizedExpected}"`);
      console.log(`    Returned: "${r.returned}" → "${r.normalizedReturned}"`);
      console.log(`    Name: ${r.name}`);
    });
    if (mismatches.length > 10) {
      console.log(`... and ${mismatches.length - 10} more`);
    }
  }

  console.log('\n' + '='.repeat(60));

  const results = {
    timestamp: new Date().toISOString(),
    summary: {
      totalRecords,
      recordsWithResults,
      recordsWithPostcode,
      correctMatches,
      noResultsCount: noResults.length,
      missingPostcodesCount: missingPostcodes.length,
      mismatchesCount: mismatches.length
    },
    metrics: {
      precision,
      accuracy,
      coverage
    },
    details: {
      noResults: noResults,
      missingPostcodes: missingPostcodes,
      mismatches: mismatches
    }
  };

  return results;
}

module.exports = { evaluatePostcodes };
