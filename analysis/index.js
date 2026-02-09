const fs = require('fs');
const path = require('path');
const { evaluatePostcodes } = require('./evaluator');

function parseArgs() {
  const args = process.argv.slice(2);
  const debug = args.includes('--debug') || args.includes('-d');
  const storeResults = args.includes('--store-results');
  
  let name = '';
  const nameIdx = args.indexOf('--name');
  if (nameIdx !== -1 && nameIdx + 1 < args.length) {
    name = args[nameIdx + 1];
  } else {
    const nameIdxShort = args.indexOf('-n');
    if (nameIdxShort !== -1 && nameIdxShort + 1 < args.length) {
      name = args[nameIdxShort + 1];
    }
  }
  
  let filterRegion = '';
  const regionIdx = args.indexOf('--filter-region');
  if (regionIdx !== -1 && regionIdx + 1 < args.length) {
    filterRegion = args[regionIdx + 1];
  } else {
    const regionIdxShort = args.indexOf('--region');
    if (regionIdxShort !== -1 && regionIdxShort + 1 < args.length) {
      filterRegion = args[regionIdxShort + 1];
    }
  }
  
  let peliasInstance = 'london';  // Default to London
  const instanceIdx = args.indexOf('--pelias-instance');
  if (instanceIdx !== -1 && instanceIdx + 1 < args.length) {
    peliasInstance = args[instanceIdx + 1];
  } else {
    const instanceIdxShort = args.indexOf('--instance');
    if (instanceIdxShort !== -1 && instanceIdxShort + 1 < args.length) {
      peliasInstance = args[instanceIdxShort + 1];
    }
  }
  
  return { debug, storeResults, name, filterRegion, peliasInstance };
}

function escapeCSVField(field) {
  if (field === null || field === undefined) {
    return '';
  }
  const str = String(field);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function appendToSummaryCSV(resultsDir, name, results) {
  const summaryCSVPath = path.join(resultsDir, 'experiments_summary.csv');
  const headers = [
    'experiment-num',
    'name',
    'accuracy',
    'precision',
    'coverage',
    'totalrecords',
    'recordswithresults',
    'noresultscount',
    'missingpostcodescount',
    'mismatchescount'
  ];

  let experimentNum = 1;
  
  if (fs.existsSync(summaryCSVPath)) {
    const content = fs.readFileSync(summaryCSVPath, 'utf-8');
    const lines = content.trim().split('\n');
    if (lines.length > 1) {
      experimentNum = lines.length;
    }
  } else {
    fs.writeFileSync(summaryCSVPath, headers.join(',') + '\n', 'utf-8');
  }

  const row = [
    experimentNum,
    name,
    results.metrics.accuracy.toFixed(2),
    results.metrics.precision.toFixed(2),
    results.metrics.coverage.toFixed(2),
    results.summary.totalRecords,
    results.summary.recordsWithResults,
    results.summary.noResultsCount,
    results.summary.missingPostcodesCount,
    results.summary.mismatchesCount
  ].map(escapeCSVField).join(',');

  fs.appendFileSync(summaryCSVPath, row + '\n', 'utf-8');
  return summaryCSVPath;
}

const { configurePeliasInstance } = require('./elasticsearch');

const { debug, storeResults, name, filterRegion, peliasInstance } = parseArgs();

// Configure which Pelias instance to query
configurePeliasInstance(peliasInstance);
console.log(`Using Pelias instance: ${peliasInstance} (port ${require('./elasticsearch').ELASTICSEARCH_PORT})`);

if (storeResults && !name) {
  console.error('Error: --store-results requires --name or -n flag with a value');
  console.error('Usage: node index.js --store-results --name "experiment-name"');
  process.exit(1);
}

const csvPath = path.join(__dirname, 'postcode_txs_labelled_229_from_lbg_sample_enriched_with_cleaned_desc.csv');

if (!fs.existsSync(csvPath)) {
  console.error(`Error: CSV file not found at ${csvPath}`);
  console.error('Please create analysis/postcode_data.csv with columns: latitude, longitude, ground_truth_postcode');
  process.exit(1);
}

evaluatePostcodes(csvPath, debug, filterRegion).then((results) => {
  if (storeResults && name) {
    const resultsDir = path.join(__dirname, 'evaluation_results');
    
    if (!fs.existsSync(resultsDir)) {
      fs.mkdirSync(resultsDir, { recursive: true });
    }
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').split('.')[0];
    const filename = `${timestamp}_${name}.json`;
    const outputPath = path.join(resultsDir, filename);
    
    fs.writeFileSync(outputPath, JSON.stringify(results, null, 2), 'utf-8');
    console.log(`\nResults saved to: ${outputPath}`);
    
    const summaryCSVPath = appendToSummaryCSV(resultsDir, name, results);
    console.log(`Summary appended to: ${summaryCSVPath}`);
  }
}).catch((error) => {
  console.error('Evaluation failed:', error);
  process.exit(1);
});
