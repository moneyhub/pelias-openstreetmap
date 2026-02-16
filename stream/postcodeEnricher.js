/**
  The postcode enricher queries an external Elasticsearch index (geolocation-places)
  to find and enrich postcodes for OSM records that are missing them.
  
  Uses a two-stage search strategy:
  1. Name + partial postcode + geo/street filter
  2. Fallback: geo-filtered address search
**/

const through = require('through2');
const http = require('http');
const peliasLogger = require('pelias-logger').get('openstreetmap');
const peliasConfig = require('pelias-config').generate();

// Read external Elasticsearch config from pelias.json
// Check for both externalElasticsearch and postcodeEnrichment.elasticsearch (pelias-docker format)
let externalEsConfig = null;
let externalEsHosts = null;
let EXTERNAL_ES_HOST = 'localhost';
let EXTERNAL_ES_PORT = 9201;
let EXTERNAL_INDEX = 'geolocation-places';

// Debug: Log the full config structure to see what we're getting
console.log('[postcodeEnricher] Full peliasConfig.imports:', JSON.stringify(peliasConfig.imports, null, 2));

const osmConfig = peliasConfig.imports?.openstreetmap;

// Try to read externalElasticsearch config (preferred format)
if (osmConfig?.externalElasticsearch) {
  externalEsConfig = osmConfig.externalElasticsearch;
  console.log('[postcodeEnricher] ✓ Found externalElasticsearch config:', JSON.stringify(externalEsConfig, null, 2));
}
// Try postcodeEnrichment.elasticsearch (pelias-docker format)
else if (osmConfig?.postcodeEnrichment?.elasticsearch) {
  externalEsConfig = osmConfig.postcodeEnrichment.elasticsearch;
  console.log('[postcodeEnricher] ✓ Found postcodeEnrichment.elasticsearch config:', JSON.stringify(externalEsConfig, null, 2));
  
  // Also check for index in postcodeEnrichment
  if (osmConfig.postcodeEnrichment.index) {
    EXTERNAL_INDEX = osmConfig.postcodeEnrichment.index;
    console.log('[postcodeEnricher] ✓ Using index from postcodeEnrichment:', EXTERNAL_INDEX);
  }
}

// Process the config if we found one
if (externalEsConfig) {
  // Read hosts from config
  if (externalEsConfig.hosts && Array.isArray(externalEsConfig.hosts) && externalEsConfig.hosts.length > 0) {
    externalEsHosts = externalEsConfig.hosts;
    EXTERNAL_ES_HOST = externalEsConfig.hosts[0].host || 'localhost';
    EXTERNAL_ES_PORT = externalEsConfig.hosts[0].port !== undefined ? externalEsConfig.hosts[0].port : 9201;
    console.log('[postcodeEnricher] ✓ Using external ES hosts:', JSON.stringify(externalEsHosts, null, 2));
  } else {
    console.log('[postcodeEnricher] ⚠ Config found but no valid hosts array, using defaults');
  }
  
  // Read index from config if specified (and not already set from postcodeEnrichment)
  if (externalEsConfig.index && !osmConfig?.postcodeEnrichment?.index) {
    EXTERNAL_INDEX = externalEsConfig.index;
    console.log('[postcodeEnricher] ✓ Using index from config:', EXTERNAL_INDEX);
  }
} else {
  console.log('[postcodeEnricher] ⚠ No externalElasticsearch or postcodeEnrichment.elasticsearch config found');
  console.log('[postcodeEnricher] ⚠ Falling back to esclient config (this should not happen if config is correct)');
  
  // Fallback to esclient only if no external config is found
  if (peliasConfig.esclient && peliasConfig.esclient.hosts && peliasConfig.esclient.hosts.length > 0) {
    externalEsHosts = peliasConfig.esclient.hosts;
    EXTERNAL_ES_HOST = peliasConfig.esclient.hosts[0].host || 'localhost';
    EXTERNAL_ES_PORT = peliasConfig.esclient.hosts[0].port !== undefined ? peliasConfig.esclient.hosts[0].port : 9200;
    console.log('[postcodeEnricher] ⚠ Using esclient as fallback:', EXTERNAL_ES_HOST, ':', EXTERNAL_ES_PORT);
  }
}

console.log('[postcodeEnricher] Final external ES config - Host:', EXTERNAL_ES_HOST, 'Port:', EXTERNAL_ES_PORT, 'Index:', EXTERNAL_INDEX);

const PARTIAL_PC_CHARS = 4;
const STAGE1_DISTANCE = '100m';
const NAME_FUZZINESS = 'AUTO';
const USE_STREET_FILTER = false;
const BATCH_SIZE = 100;
const POSTCODE_CANDIDATE_LIMIT = 5;
const POSTCODE_ESTIMATION_DISTANCE = '1km'; // Distance to search for nearby postcodes
const PRELOOKUP_ESTIMATION_DISTANCE = '1000m'; // Distance for prelookup estimation mode
const FULL_UK_POSTCODE_REGEX = /^(GIR\s0AA|[A-Z]{1,2}\d[A-Z\d]?\s\d[A-Z]{2})$/;
const INVALID_POSTCODE_SAMPLE_LIMIT = 10;

function normalizePostcode(postcode) {
  if (!postcode || typeof postcode !== 'string') {
    return '';
  }
  const compact = postcode.trim().toUpperCase().replace(/\s+/g, '');
  if (compact.length > 3) {
    return `${compact.slice(0, -3)} ${compact.slice(-3)}`;
  }
  return compact;
}

function isFullUKPostcode(postcode) {
  const normalized = normalizePostcode(postcode);
  return normalized !== '' && FULL_UK_POSTCODE_REGEX.test(normalized);
}

function selectFirstValidExternalPostcode(hits, context = 'external', onInvalidPostcode = null) {
  if (!Array.isArray(hits)) {
    return null;
  }

  for (const hit of hits) {
    const postcode = hit?._source?.address?.postcode;
    if (isFullUKPostcode(postcode)) {
      return normalizePostcode(postcode);
    }
    if (postcode && typeof onInvalidPostcode === 'function') {
      onInvalidPostcode(postcode, context);
    }
  }

  return null;
}

function buildGeoDistanceFilter(lat, lon, distance) {
  return {
    geo_distance: {
      distance: distance,
      location: {
        lat: lat,
        lon: lon
      }
    }
  };
}

function buildGeoDistanceSort(lat, lon) {
  return {
    _geo_distance: {
      location: { lat: lat, lon: lon },
      order: 'asc',
      unit: 'm'
    }
  };
}

function buildGBFilters() {
  return [
    {
      term: {
        'address.country': 'GB'
      }
    }
  ];
}

function buildAddressShouldClauses(params) {
  const should = [];
  
  if (params.street) {
    should.push({
      match_phrase: {
        'address.street': {
          query: params.street,
          boost: 10.0
        }
      }
    });
  }
  
  if (params.city) {
    should.push({
      match: {
        'address.city': {
          query: params.city,
          boost: 5.0
        }
      }
    });
  }
  
  if (params.postcode_area) {
    should.push({
      term: {
        'address.postcodeArea': {
          value: params.postcode_area,
          boost: 8.0
        }
      }
    });
  }
  
  return should;
}

function queryPeliasForClosestPostcode(lat, lon, distance = POSTCODE_ESTIMATION_DISTANCE) {
  return new Promise((resolve, reject) => {
    const esConfig = peliasConfig.esclient;
    if (!esConfig || !esConfig.hosts || esConfig.hosts.length === 0) {
      return resolve(null);
    }
    
    const host = esConfig.hosts[0];
    const peliasHost = host.host || 'localhost';
    const peliasPort = host.port || 9200;
    const peliasIndex = 'pelias';
    
    const queryBody = {
      query: {
        bool: {
          must: [
            {
              exists: {
                field: 'address_parts.zip'
              }
            }
          ],
          filter: [
            {
              geo_distance: {
                distance: distance,
                center_point: {
                  lat: lat,
                  lon: lon
                }
              }
            }
          ]
        }
      },
      sort: [
        {
          _geo_distance: {
            center_point: { lat: lat, lon: lon },
            order: 'asc',
            unit: 'm'
          }
        }
      ],
      size: 1
    };
    
    const body = JSON.stringify(queryBody);
    // For ES 6.x, use _doc type in search path
    const searchPath = `/${peliasIndex}/_doc/_search`;
    const options = {
      hostname: peliasHost,
      port: peliasPort,
      path: searchPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          const hits = result.hits?.hits || [];
          if (hits.length > 0) {
            const postcode = hits[0]._source?.address_parts?.zip || null;
            resolve(postcode);
          } else {
            resolve(null);
          }
        } catch (err) {
          reject(err);
        }
      });
    });
    
    req.on('error', (err) => {
      // Don't fail the whole process if Pelias query fails
      peliasLogger.warn('[postcodeEnricher] Failed to query Pelias for postcode estimation', err);
      resolve(null);
    });
    
    req.write(body);
    req.end();
  });
}

function extractPostcodeArea(postcode) {
  if (!postcode || typeof postcode !== 'string') {
    return '';
  }
  
  const cleaned = postcode.trim().toUpperCase();
  // UK postcodes: extract the outward code (first part before space)
  // e.g., "SW1A 1AA" -> "SW1A", "M1 1AA" -> "M1"
  const match = cleaned.match(/^([A-Z]{1,2}\d{1,2}[A-Z]?)/);
  if (match) {
    return match[1];
  }
  
  // Fallback: take first 2-4 characters if it looks like a postcode
  if (cleaned.length >= 2) {
    return cleaned.substring(0, Math.min(4, cleaned.length));
  }
  
  return '';
}

function geoFilteredAddress(searchParamsList, distance = '100m', onInvalidPostcode = null) {
  return new Promise((resolve, reject) => {
    if (!searchParamsList || searchParamsList.length === 0) {
      return resolve([]);
    }
    
    const lines = [];
    
    for (const params of searchParamsList) {
      if (!params || params.latitude === null || params.longitude === null) {
        lines.push(`{"index": "${EXTERNAL_INDEX}"}`);
        lines.push('{"query": {"match_none": {}}, "size": 0}');
        continue;
      }
      
      const lat = params.latitude;
      const lon = params.longitude;
      const should = buildAddressShouldClauses(params);
      
      const boolQuery = {
        filter: [buildGeoDistanceFilter(lat, lon, distance), ...buildGBFilters()]
      };
      
      if (should.length > 0) {
        boolQuery.should = should;
      }
      
      const queryBody = {
        query: { bool: boolQuery },
        size: POSTCODE_CANDIDATE_LIMIT
      };
      
      const sort = buildGeoDistanceSort(lat, lon);
      if (sort) {
        queryBody.sort = [sort];
      }
      
      lines.push(`{"index": "${EXTERNAL_INDEX}"}`);
      lines.push(JSON.stringify(queryBody));
    }
    
    if (lines.length === 0) {
      return resolve([]);
    }
    
    const body = lines.join('\n') + '\n';
    const options = {
      hostname: EXTERNAL_ES_HOST,
      port: EXTERNAL_ES_PORT,
      path: '/_msearch',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-ndjson',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          const results = [];
          for (const resp of result.responses) {
            const hits = resp.hits?.hits || [];
            const selectedPostcode = selectFirstValidExternalPostcode(hits, 'stage2', onInvalidPostcode);
            if (selectedPostcode) {
              results.push({
                postcode: selectedPostcode
              });
            } else {
              results.push(null);
            }
          }
          resolve(results);
        } catch (err) {
          reject(err);
        }
      });
    });
    
    req.on('error', (err) => {
      reject(err);
    });
    
    req.write(body);
    req.end();
  });
}

function twoStageSearch(searchParamsList, onInvalidPostcode = null) {
  return new Promise((resolve, reject) => {
    if (!searchParamsList || searchParamsList.length === 0) {
      return resolve([]);
    }
    
    const n = searchParamsList.length;
    const results = new Array(n).fill(null);
    const remainingIndices = [];
    const stage1Lines = [];
    const stage1Map = [];
    
    for (let i = 0; i < n; i++) {
      const params = searchParamsList[i];
      const queryName = params.name;
      
      if (!params || !queryName) {
        remainingIndices.push(i);
        continue;
      }
      
      if (USE_STREET_FILTER) {
        if (!params.street) {
          remainingIndices.push(i);
          continue;
        }
      } else {
        if (!params.latitude || !params.longitude) {
          remainingIndices.push(i);
          continue;
        }
      }
      
      const lat = params.latitude;
      const lon = params.longitude;
      const fullPc = params.postcode || '';
      
      let partialPc = '';
      if (fullPc && fullPc.length >= PARTIAL_PC_CHARS) {
        partialPc = fullPc.substring(0, PARTIAL_PC_CHARS).toUpperCase();
      } else {
        partialPc = (params.postcode_area || '').toUpperCase();
      }
      
      if (!partialPc) {
        remainingIndices.push(i);
        continue;
      }
      
      const filters = [
        { prefix: { 'address.postcode': partialPc } },
        ...buildGBFilters()
      ];
      
      if (USE_STREET_FILTER) {
        filters.push({ match: { 'address.street': params.street } });
      } else {
        filters.push(buildGeoDistanceFilter(lat, lon, STAGE1_DISTANCE));
      }
      
      const queryBody = {
        query: {
          bool: {
            must: [{
              match: {
                name: {
                  query: queryName,
                  fuzziness: NAME_FUZZINESS
                }
              }
            }],
            filter: filters
          }
        },
        size: POSTCODE_CANDIDATE_LIMIT
      };
      
      stage1Lines.push(`{"index": "${EXTERNAL_INDEX}"}`);
      stage1Lines.push(JSON.stringify(queryBody));
      stage1Map.push(i);
    }
    
    const stage1Promise = (stage1Lines.length > 0) ?
      new Promise((resolveStage1, rejectStage1) => {
          const body = stage1Lines.join('\n') + '\n';
          const options = {
            hostname: EXTERNAL_ES_HOST,
            port: EXTERNAL_ES_PORT,
            path: '/_msearch',
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-ndjson',
              'Content-Length': Buffer.byteLength(body)
            }
          };
          
          const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => {
              data += chunk;
            });
            res.on('end', () => {
              try {
                const result = JSON.parse(data);
                const stage1Results = [];
                for (const resp of result.responses) {
                  const hits = resp.hits?.hits || [];
                  const selectedPostcode = selectFirstValidExternalPostcode(hits, 'stage1', onInvalidPostcode);
                  if (selectedPostcode) {
                    stage1Results.push({
                      postcode: selectedPostcode
                    });
                  } else {
                    stage1Results.push(null);
                  }
                }
                resolveStage1(stage1Results);
              } catch (err) {
                rejectStage1(err);
              }
            });
          });
          
          req.on('error', (err) => {
            rejectStage1(err);
          });
          
          req.write(body);
          req.end();
        })
      : Promise.resolve([]);
    
    stage1Promise
      .then((stage1Results) => {
        const foundIndices = new Set();
        for (let j = 0; j < stage1Map.length; j++) {
          const idx = stage1Map[j];
          if (stage1Results[j]) {
            results[idx] = stage1Results[j];
            foundIndices.add(idx);
          }
        }
        
        const remainingAfterStage1 = remainingIndices.filter(idx => !foundIndices.has(idx));
        
        if (remainingAfterStage1.length === 0) {
          return resolve(results);
        }
        
        const stage2Params = remainingAfterStage1.map(i => searchParamsList[i]);
        return geoFilteredAddress(stage2Params, STAGE1_DISTANCE, onInvalidPostcode)
          .then((stage2Results) => {
            for (let j = 0; j < remainingAfterStage1.length; j++) {
              const idx = remainingAfterStage1[j];
              if (stage2Results[j]) {
                results[idx] = stage2Results[j];
              }
            }
            resolve(results);
          });
      })
      .catch(reject);
  });
}

function checkExternalElasticsearchConnection() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: EXTERNAL_ES_HOST,
      port: EXTERNAL_ES_PORT,
      path: `/${EXTERNAL_INDEX}/_count`,
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    };
    
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const result = JSON.parse(data);
            resolve({
              connected: true,
              documentCount: result.count || 0,
              index: EXTERNAL_INDEX,
              host: EXTERNAL_ES_HOST,
              port: EXTERNAL_ES_PORT
            });
          } catch (err) {
            resolve({
              connected: true,
              documentCount: null,
              index: EXTERNAL_INDEX,
              host: EXTERNAL_ES_HOST,
              port: EXTERNAL_ES_PORT,
              error: 'Failed to parse response'
            });
          }
        } else {
          resolve({
            connected: false,
            error: `HTTP ${res.statusCode}: ${data}`,
            host: EXTERNAL_ES_HOST,
            port: EXTERNAL_ES_PORT
          });
        }
      });
    });
    
    req.on('error', (err) => {
      resolve({
        connected: false,
        error: err.message,
        host: EXTERNAL_ES_HOST,
        port: EXTERNAL_ES_PORT
      });
    });
    
    req.setTimeout(5000, () => {
      req.destroy();
      resolve({
        connected: false,
        error: 'Connection timeout',
        host: EXTERNAL_ES_HOST,
        port: EXTERNAL_ES_PORT
      });
    });
    
    req.end();
  });
}

module.exports = function() {
  const enablePostcodeEstimation = peliasConfig.imports?.openstreetmap?.postcodeEstimation === true;
  const estimationMode = peliasConfig.imports?.openstreetmap?.postcodeEstimationMode || 'fallback'; // 'fallback' or 'prelookup'
  
  console.log('[postcodeEnricher] ========================================');
  console.log('[postcodeEnricher] Initializing postcode enricher...');
  console.log(`[postcodeEnricher] External Elasticsearch: ${EXTERNAL_ES_HOST}:${EXTERNAL_ES_PORT}`);
  console.log(`[postcodeEnricher] External index: ${EXTERNAL_INDEX}`);
  console.log(`[postcodeEnricher] Postcode estimation: ${enablePostcodeEstimation ? 'ENABLED' : 'DISABLED'}`);
  if (enablePostcodeEstimation) {
    console.log(`[postcodeEnricher] Estimation mode: ${estimationMode}`);
  }
  console.log('[postcodeEnricher] Checking external Elasticsearch connection...');
  
  checkExternalElasticsearchConnection()
    .then((stats) => {
      if (stats.connected) {
        console.log('[postcodeEnricher] ✓ Successfully connected to external Elasticsearch');
        console.log(`[postcodeEnricher]   Host: ${stats.host}:${stats.port}`);
        console.log(`[postcodeEnricher]   Index: ${stats.index}`);
        if (stats.documentCount !== null) {
          console.log(`[postcodeEnricher]   Document count: ${stats.documentCount.toLocaleString()}`);
        }
        peliasLogger.info('[postcodeEnricher] Successfully connected to external Elasticsearch', {
          host: stats.host,
          port: stats.port,
          index: stats.index,
          documentCount: stats.documentCount
        });
      } else {
        console.log('[postcodeEnricher] ✗ Failed to connect to external Elasticsearch');
        console.log(`[postcodeEnricher]   Host: ${stats.host}:${stats.port}`);
        console.log(`[postcodeEnricher]   Error: ${stats.error}`);
        peliasLogger.warn('[postcodeEnricher] Failed to connect to external Elasticsearch', {
          host: stats.host,
          port: stats.port,
          error: stats.error
        });
      }
      console.log('[postcodeEnricher] ========================================');
    })
    .catch((err) => {
      console.log('[postcodeEnricher] ✗ Error checking external Elasticsearch connection');
      console.log(`[postcodeEnricher]   Error: ${err.message}`);
      peliasLogger.error('[postcodeEnricher] Error checking external Elasticsearch connection', err);
      console.log('[postcodeEnricher] ========================================');
    });
  
  peliasLogger.info('[postcodeEnricher] Initializing postcode enricher...');
  peliasLogger.info(`[postcodeEnricher] Postcode estimation: ${enablePostcodeEstimation ? 'ENABLED' : 'DISABLED'}`);
  if (enablePostcodeEstimation) {
    peliasLogger.info(`[postcodeEnricher] Estimation mode: ${estimationMode}`);
  }
  
  const batch = [];
  let processedCount = 0;
  let enrichedCount = 0;
  let totalProcessed = 0;
  let totalEnriched = 0;
  let totalSkipped = 0;
  let totalNoCoords = 0;
  let totalReceived = 0;
  let totalEstimated = 0;
  let totalInvalidPostcodes = 0;
  const enrichedSamples = [];
  const notEnrichedSamples = [];
  const invalidPostcodeSamples = [];
  const LOG_INTERVAL = 10000;

  function recordInvalidPostcodeSample(postcode, context, docId = null) {
    if (!postcode || typeof postcode !== 'string' || postcode.trim() === '') {
      return;
    }

    totalInvalidPostcodes++;

    if (invalidPostcodeSamples.length < INVALID_POSTCODE_SAMPLE_LIMIT) {
      const sample = {
        postcode: postcode,
        context: context,
        docId: docId
      };
      invalidPostcodeSamples.push(sample);

      const msg = `[postcodeEnricher] ⚠ Rejected postcode "${sample.postcode}" ` +
        `(context: ${sample.context}${sample.docId ? `, doc: ${sample.docId}` : ''})`;
      console.log(msg);
      peliasLogger.info(msg);
    }
  }
  
  const stream = through.obj(function(doc, enc, next) {
    totalReceived++;
    
    if (totalReceived === 1) {
      console.log('[postcodeEnricher] First document received!');
      peliasLogger.info('[postcodeEnricher] First document received');
    }
    
    if (totalReceived % 50000 === 0) {
      console.log(`[postcodeEnricher] Received ${totalReceived} documents so far...`);
      peliasLogger.info(`[postcodeEnricher] Received ${totalReceived} documents so far`);
    }
    try {
      const currentZip = doc.getAddress('zip');
      
      if (!currentZip || currentZip.trim() === '') {
        const centroid = doc.getCentroid();
        
        if (centroid && centroid.lat && centroid.lon) {
          const name = doc.getName('default') || '';
          const street = doc.getAddress('street') || '';
          const city = doc.getAddress('city') || '';
          let postcodeArea = '';
          
          // If postcode estimation is enabled in "prelookup" mode and we don't have a postcode area,
          // we'll estimate it BEFORE external ES lookup (in processBatch)
          // If in "fallback" mode, we'll estimate AFTER external ES lookup fails
          const needsPrelookupEstimation = enablePostcodeEstimation && estimationMode === 'prelookup' && !postcodeArea;
          const needsFallbackEstimation = enablePostcodeEstimation && estimationMode === 'fallback' && !postcodeArea;
          
          batch.push({
            doc: doc,
            params: {
              name: name,
              latitude: centroid.lat,
              longitude: centroid.lon,
              street: street,
              city: city,
              postcode: '',
              postcode_area: postcodeArea,
              needsPrelookupEstimation: needsPrelookupEstimation,
              needsFallbackEstimation: needsFallbackEstimation
            }
          });
        } else {
          totalNoCoords++;
          this.push(doc);
        }
      } else {
        totalSkipped++;
        this.push(doc);
      }
      
      if (batch.length >= BATCH_SIZE) {
        processBatch.call(this, batch.slice(), () => {
          batch.length = 0;
          next();
        });
      } else {
        next();
      }
    } catch (e) {
      peliasLogger.error('[postcodeEnricher] error processing document', e);
      peliasLogger.error(e.stack);
      next();
    }
  }, function(flushCallback) {
    if (batch.length > 0) {
      processBatch.call(this, batch, () => {
        logSummary();
        flushCallback();
      });
    } else {
      logSummary();
      flushCallback();
    }
  });
  
  function processBatch(batchToProcess, callback) {
    if (batchToProcess.length === 0) {
      return callback();
    }
    
    // MODE 2 (prelookup): Estimate postcode areas BEFORE external ES lookup
    // Query Pelias for closest postcode, extract area, use it in external ES search
    const prelookupPromises = batchToProcess.map((item, idx) => {
      if (item.params.needsPrelookupEstimation && enablePostcodeEstimation) {
        return queryPeliasForClosestPostcode(item.params.latitude, item.params.longitude, PRELOOKUP_ESTIMATION_DISTANCE)
          .then((estimatedPostcode) => {
            if (estimatedPostcode) {
              const estimatedArea = extractPostcodeArea(estimatedPostcode);
              if (estimatedArea) {
                item.params.postcode_area = estimatedArea;
                totalEstimated++;
                if (totalEstimated <= 10) {
                  console.log(
                    `[postcodeEnricher] [PRELOCKUP] Estimated postcode area "${estimatedArea}" ` +
                    `from nearby postcode "${estimatedPostcode}" (within ${PRELOOKUP_ESTIMATION_DISTANCE}) ` +
                    `for record ${item.doc.getId()}`
                  );
                }
              } else {
                if (totalEstimated <= 10) {
                  console.log(`[postcodeEnricher] [PRELOOCKUP] Found postcode "${estimatedPostcode}" but couldn't extract area`);
                }
              }
            } else {
              // Debug: log when no postcode found (only first few times)
              if (totalEstimated === 0 && idx === 0) {
                console.log(
                  `[postcodeEnricher] [PRELOCKUP] No postcode found for record ${item.doc.getId()} ` +
                  `at (${item.params.latitude}, ${item.params.longitude})`
                );
              }
            }
            item.params.needsPrelookupEstimation = false;
            return null;
          })
          .catch((err) => {
            peliasLogger.warn('[postcodeEnricher] Prelookup postcode estimation failed for record', err);
            if (totalEstimated === 0) {
              console.log(`[postcodeEnricher] [PRELOCKUP] Error querying Pelias: ${err.message}`);
            }
            item.params.needsPrelookupEstimation = false;
            return null;
          });
      }
      return Promise.resolve(null);
    });
    
    Promise.all(prelookupPromises)
      .then(() => {
        const searchParams = batchToProcess.map(item => {
          // Remove estimation flags from params before searching
          const { needsPrelookupEstimation, needsFallbackEstimation, ...params } = item.params;
          return params;
        });
        
        return twoStageSearch(searchParams, recordInvalidPostcodeSample);
      })
      .then((results) => {
        // MODE 1 (fallback): If external ES search failed, estimate postcode from Pelias
        const fallbackPromises = batchToProcess.map((item, idx) => {
          const result = results[idx];
          // If search failed AND we need fallback estimation
          if (!result && item.params.needsFallbackEstimation && enablePostcodeEstimation) {
            return queryPeliasForClosestPostcode(item.params.latitude, item.params.longitude)
              .then((estimatedPostcode) => {
                if (isFullUKPostcode(estimatedPostcode)) {
                  const normalizedEstimatedPostcode = normalizePostcode(estimatedPostcode);
                  // Use the estimated postcode directly (fallback mode)
                  results[idx] = { postcode: normalizedEstimatedPostcode };
                  totalEstimated++;
                  if (totalEstimated <= 3) {
                    console.log(
                      `[postcodeEnricher] [FALLBACK] Estimated postcode "${normalizedEstimatedPostcode}" ` +
                      `from nearby record (within ${POSTCODE_ESTIMATION_DISTANCE}) ` +
                      `for record ${item.doc.getId()}`
                    );
                  }
                } else if (estimatedPostcode) {
                  recordInvalidPostcodeSample(estimatedPostcode, 'fallback-estimation', item.doc.getId());
                }
                return null;
              })
              .catch((err) => {
                peliasLogger.warn('[postcodeEnricher] Fallback postcode estimation failed for record', err);
                return null;
              });
          }
          return Promise.resolve(null);
        });
        
        return Promise.all(fallbackPromises).then(() => results);
      })
      .then((results) => {
        for (let i = 0; i < batchToProcess.length; i++) {
          const { doc } = batchToProcess[i];
          const result = results[i];
          
          processedCount++;
          totalProcessed++;
          
          if (result && isFullUKPostcode(result.postcode)) {
            const normalizedPostcode = normalizePostcode(result.postcode);
            const oldPostcode = doc.getAddress('zip') || '(none)';
            doc.setAddress('zip', normalizedPostcode);
            const verifyPostcode = doc.getAddress('zip');
            
            enrichedCount++;
            totalEnriched++;
            
            if (enrichedSamples.length < 10) {
              enrichedSamples.push({
                id: doc.getId(),
                name: doc.getName('default') || 'N/A',
                oldPostcode: oldPostcode,
                newPostcode: normalizedPostcode,
                verifiedPostcode: verifyPostcode,
                lat: doc.getCentroid()?.lat,
                lon: doc.getCentroid()?.lon
              });
            }
            
            if (totalEnriched <= 5) {
              const docAddressParts = doc.address_parts || {};
              const docZip = docAddressParts.zip || '(not in address_parts)';
              console.log(
                `[postcodeEnricher] ✓ ENRICHED #${totalEnriched}: ID=${doc.getId()}, ` +
                `Name="${doc.getName('default') || 'N/A'}", Old="${oldPostcode}" → New="${normalizedPostcode}" ` +
                `(verified: ${verifyPostcode}, doc.address_parts.zip: ${docZip})`
              );
            }
            
            this.push(doc);
          } else {
            if (result && result.postcode) {
              recordInvalidPostcodeSample(result.postcode, 'final-guard', doc.getId());
            }
            if (notEnrichedSamples.length < 5) {
              notEnrichedSamples.push({
                id: doc.getId(),
                name: doc.getName('default') || 'N/A',
                lat: doc.getCentroid()?.lat,
                lon: doc.getCentroid()?.lon
              });
            }
            
            this.push(doc);
          }
          
          if (totalProcessed % LOG_INTERVAL === 0) {
            const msg = `[postcodeEnricher] Progress: ${totalProcessed} processed, ` +
              `${totalEnriched} enriched (${((totalEnriched / totalProcessed) * 100).toFixed(2)}%), ` +
              `${totalEstimated} postcode areas estimated`;
            console.log(msg);
            peliasLogger.info(msg);
          }
        }
        callback();
      })
      .catch((error) => {
        peliasLogger.error('[postcodeEnricher] batch query failed', error);
        peliasLogger.error(error.stack);
        
        for (const { doc } of batchToProcess) {
          processedCount++;
          totalProcessed++;
          this.push(doc);
          
          if (totalProcessed % LOG_INTERVAL === 0) {
            const msg = `[postcodeEnricher] Progress: ${totalProcessed} processed, ` +
              `${totalEnriched} enriched (${((totalEnriched / totalProcessed) * 100).toFixed(2)}%), ` +
              `${totalEstimated} postcode areas estimated`;
            console.log(msg);
            peliasLogger.info(msg);
          }
        }
        callback();
      });
  }
  
  function logSummary() {
    const totalChecked = totalProcessed + totalSkipped + totalNoCoords;
    console.log('');
    console.log('[postcodeEnricher] ========================================');
    console.log('[postcodeEnricher] Final Summary:');
    console.log(`[postcodeEnricher]   Total records received: ${totalReceived}`);
    console.log(`[postcodeEnricher]   Total records checked: ${totalChecked}`);
    console.log(`[postcodeEnricher]   Records with existing postcode (skipped): ${totalSkipped}`);
    console.log(`[postcodeEnricher]   Records without coordinates (skipped): ${totalNoCoords}`);
    console.log(`[postcodeEnricher]   Records processed for enrichment: ${totalProcessed}`);
    console.log(`[postcodeEnricher]   Records successfully enriched: ${totalEnriched}`);
    console.log(`[postcodeEnricher]   Success rate: ${totalProcessed > 0 ? ((totalEnriched / totalProcessed) * 100).toFixed(2) : 0}%`);
    if (enablePostcodeEstimation) {
      console.log(`[postcodeEnricher]   Postcode areas estimated: ${totalEstimated}`);
    }
    if (totalInvalidPostcodes > 0) {
      console.log(`[postcodeEnricher]   Invalid postcode candidates rejected: ${totalInvalidPostcodes}`);
    }
    console.log('[postcodeEnricher] ========================================');
    console.log('');
    
    peliasLogger.info(`[postcodeEnricher] ========================================`);
    peliasLogger.info(`[postcodeEnricher] Final Summary:`);
    peliasLogger.info(`[postcodeEnricher]   Total records received: ${totalReceived}`);
    peliasLogger.info(`[postcodeEnricher]   Total records checked: ${totalChecked}`);
    peliasLogger.info(`[postcodeEnricher]   Records with existing postcode (skipped): ${totalSkipped}`);
    peliasLogger.info(`[postcodeEnricher]   Records without coordinates (skipped): ${totalNoCoords}`);
    peliasLogger.info(`[postcodeEnricher]   Records processed for enrichment: ${totalProcessed}`);
    peliasLogger.info(`[postcodeEnricher]   Records successfully enriched: ${totalEnriched}`);
    const successRate = (totalProcessed > 0) ?
      ((totalEnriched / totalProcessed) * 100).toFixed(2) :
      0;
    peliasLogger.info(`[postcodeEnricher]   Success rate: ${successRate}%`);
    if (enablePostcodeEstimation) {
      peliasLogger.info(`[postcodeEnricher]   Postcode areas estimated: ${totalEstimated}`);
    }
    if (totalInvalidPostcodes > 0) {
      peliasLogger.info(`[postcodeEnricher]   Invalid postcode candidates rejected: ${totalInvalidPostcodes}`);
    }
    peliasLogger.info(`[postcodeEnricher] ========================================`);
    
    if (enrichedSamples.length > 0) {
      console.log('');
      console.log('[postcodeEnricher] Sample of enriched records (showing postcode changes):');
      enrichedSamples.forEach((sample, idx) => {
        const msg = `  ${idx + 1}. ID: ${sample.id}, Name: "${sample.name}", ` +
          `Old: "${sample.oldPostcode}" → New: "${sample.newPostcode}", ` +
          `Lat: ${sample.lat}, Lon: ${sample.lon}`;
        console.log(msg);
        peliasLogger.info(msg);
      });
    } else if (totalEnriched > 0) {
      console.log('');
      console.log('[postcodeEnricher] WARNING: Enriched records found but no samples collected!');
      console.log(`[postcodeEnricher] This suggests samples array wasn't populated correctly.`);
      console.log(`[postcodeEnricher] Total enriched: ${totalEnriched}, Samples array length: ${enrichedSamples.length}`);
    }
    
    if (notEnrichedSamples.length > 0) {
      console.log('');
      console.log('[postcodeEnricher] Sample of records not enriched:');
      notEnrichedSamples.forEach((sample, idx) => {
        const msg = `  ${idx + 1}. ID: ${sample.id}, Name: "${sample.name}", Lat: ${sample.lat}, Lon: ${sample.lon}`;
        console.log(msg);
        peliasLogger.info(msg);
      });
    }

    if (invalidPostcodeSamples.length > 0) {
      console.log('');
      console.log('[postcodeEnricher] Sample of rejected postcode candidates:');
      invalidPostcodeSamples.forEach((sample, idx) => {
        const msg = `  ${idx + 1}. Postcode: "${sample.postcode}", Context: ${sample.context}` +
          `${sample.docId ? `, Doc: ${sample.docId}` : ''}`;
        console.log(msg);
        peliasLogger.info(msg);
      });
    }
    
    if (totalProcessed === 0) {
      console.log('[postcodeEnricher] WARNING: No records were processed for enrichment!');
      console.log(`[postcodeEnricher]   Total received: ${totalReceived}`);
      console.log(`[postcodeEnricher]   Skipped (has postcode): ${totalSkipped}`);
      console.log(`[postcodeEnricher]   Skipped (no coords): ${totalNoCoords}`);
      peliasLogger.warn('[postcodeEnricher] WARNING: No records were processed for enrichment. This could mean:');
      peliasLogger.warn('[postcodeEnricher]   - All records already have postcodes');
      peliasLogger.warn('[postcodeEnricher]   - Records are missing coordinates');
      peliasLogger.warn('[postcodeEnricher]   - The enricher is not receiving documents');
    }
  }
  
  stream.on('error', peliasLogger.error.bind(peliasLogger, __filename));
  
  return stream;
};
