const http = require('http');

// Default to London Pelias instance
let ELASTICSEARCH_HOST = 'localhost';
let ELASTICSEARCH_PORT = 9201;  // London Pelias ES
const INDEX_NAME = 'pelias';

// Function to configure which Pelias instance to use
function configurePeliasInstance(instance) {
  if (instance === 'london') {
    ELASTICSEARCH_HOST = 'localhost';
    ELASTICSEARCH_PORT = 9201;
  } else if (instance === 'london-baseline') {
    ELASTICSEARCH_HOST = 'localhost';
    ELASTICSEARCH_PORT = 9203;
  } else if (instance === 'uk') {
    ELASTICSEARCH_HOST = 'localhost';
    ELASTICSEARCH_PORT = 9202;
  } else if (instance === 'uk-baseline') {
    ELASTICSEARCH_HOST = 'localhost';
    ELASTICSEARCH_PORT = 9204;
  } else if (instance === 'uk-estimation' || instance === 'uk-estimation-fallback') {
    ELASTICSEARCH_HOST = 'localhost';
    ELASTICSEARCH_PORT = 9205;
  } else if (instance === 'uk-estimation-prelookup') {
    ELASTICSEARCH_HOST = 'localhost';
    ELASTICSEARCH_PORT = 9206;
  } else if (instance === 'external' || instance === 'default') {
    // For backward compatibility, use port 9200 (external Foursquare ES)
    ELASTICSEARCH_HOST = 'localhost';
    ELASTICSEARCH_PORT = 9200;
  } else {
    console.warn(`Unknown Pelias instance "${instance}", defaulting to London (port 9201)`);
    ELASTICSEARCH_HOST = 'localhost';
    ELASTICSEARCH_PORT = 9201;
  }
}

// Export getters to access current configuration
function getElasticsearchHost() { return ELASTICSEARCH_HOST; }
function getElasticsearchPort() { return ELASTICSEARCH_PORT; }

function normalizePostcode(postcode) {
  if (!postcode) {
    return '';
  }
  return postcode.toLowerCase().replace(/\s+/g, '');
}

function queryElasticsearch(lat, lon, debug = false) {
  return new Promise((resolve, reject) => {
    const query = {
      query: {
        geo_distance: {
          distance: '10km',
          center_point: {
            lat: lat,
            lon: lon
          }
        }
      },
      sort: [
        {
          _geo_distance: {
            center_point: {
              lat: lat,
              lon: lon
            },
            order: 'asc',
            unit: 'km'
          }
        }
      ],
      size: 1
    };

    const postData = JSON.stringify(query);
    const options = {
      hostname: ELASTICSEARCH_HOST,
      port: ELASTICSEARCH_PORT,
      path: `/${INDEX_NAME}/_search`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
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
          if (debug) {
            return resolve({
              source: (result.hits && result.hits.hits && result.hits.hits.length > 0) ?
                result.hits.hits[0]._source :
                null,
              fullResponse: result,
              totalHits: result.hits?.total || 0
            });
          }
          if (result.hits && result.hits.hits && result.hits.hits.length > 0) {
            resolve(result.hits.hits[0]._source);
          } else {
            resolve(null);
          }
        } catch (err) {
          reject(err);
        }
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.write(postData);
    req.end();
  });
}

module.exports = { 
  queryElasticsearch, 
  normalizePostcode, 
  configurePeliasInstance,
  getElasticsearchHost,
  getElasticsearchPort,
  get ELASTICSEARCH_HOST() { return ELASTICSEARCH_HOST; },
  get ELASTICSEARCH_PORT() { return ELASTICSEARCH_PORT; },
  INDEX_NAME 
};
