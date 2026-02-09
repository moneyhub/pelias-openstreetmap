#!/usr/bin/env node

/**
 * Generate Elasticsearch index mapping using pelias-schema
 * This script outputs the full mapping JSON that can be used to create an index
 * 
 * Based on pelias-schema API: https://github.com/moneyhub/pelias-schema
 */

const schema = require('@mft/pelias-schema');

// pelias-schema exports the full index definition (settings + mappings)
// We'll merge our custom settings with the schema's settings
let indexDefinition;

if (typeof schema === 'function') {
  // If it's a function, call it
  indexDefinition = schema();
} else if (typeof schema === 'object') {
  // If it's an object, use it directly
  indexDefinition = schema;
} else {
  console.error('ERROR: pelias-schema did not export expected format');
  process.exit(1);
}

// Fix settings structure for ES 6.x compatibility
const settings = indexDefinition.settings || {};
const indexSettings = settings.index || {};

// Remove duplicate root-level shards/replicas if they exist
delete settings.number_of_shards;
delete settings.number_of_replicas;

// Override with our custom values (ensure integers, not strings)
indexSettings.number_of_shards = 5;
indexSettings.number_of_replicas = 0;

// Merge settings properly
indexDefinition.settings = {
  ...settings,
  index: {
    ...indexSettings,
    number_of_shards: 5,
    number_of_replicas: 0
  }
};

// Ensure mappings exist
if (!indexDefinition.mappings) {
  console.error('ERROR: pelias-schema did not export mappings');
  process.exit(1);
}

// For ES 6.8.23, we need to wrap mappings in _doc type if not already wrapped
const mappings = indexDefinition.mappings;
if (mappings.properties && !mappings._doc) {
  // Mappings are at root level, need to wrap in _doc for ES 6.x
  indexDefinition.mappings = {
    _doc: mappings
  };
} else if (mappings._doc) {
  // Already wrapped, good - no action needed
  void 0; // No-op to satisfy linter
} else {
  console.error('ERROR: Mappings structure is unexpected:', Object.keys(mappings));
  process.exit(1);
}

// Fix ES 6.8.23 compatibility - remove ICU dependencies
// ES 6.8.23 doesn't have ICU plugin by default
const analysis = indexDefinition.settings.analysis || {};

// First, collect all ICU filter names before deleting them
const icuCharFilterNames = [];
const icuTokenFilterNames = [];

// Collect ICU char filter names
if (analysis.char_filter) {
  Object.keys(analysis.char_filter).forEach(filterName => {
    const filter = analysis.char_filter[filterName];
    if (filter.type === 'icu_normalizer') {
      icuCharFilterNames.push(filterName);
    }
  });
}

// Collect ICU token filter names
if (analysis.filter) {
  Object.keys(analysis.filter).forEach(filterName => {
    const filter = analysis.filter[filterName];
    if (filter.type && filter.type.startsWith('icu_')) {
      icuTokenFilterNames.push(filterName);
    }
  });
}

// Now remove the filters
icuCharFilterNames.forEach(filterName => {
  delete analysis.char_filter[filterName];
});

icuTokenFilterNames.forEach(filterName => {
  delete analysis.filter[filterName];
});

// Also remove common ICU filter names that might be referenced but not defined
// (some might be built-in names that ES 6.8.23 doesn't support)
const knownIcuFilters = ['icu_folding', 'icu_normalizer', 'icu_collation', 'icu_tokenizer'];
const allIcuFilterNames = [...icuCharFilterNames, ...icuTokenFilterNames, ...knownIcuFilters];

// Remove references from all analyzers
Object.keys(analysis.analyzer || {}).forEach(analyzerName => {
  const analyzer = analysis.analyzer[analyzerName];
  
  // Remove ICU char filter references
  if (analyzer.char_filter && Array.isArray(analyzer.char_filter)) {
    analyzer.char_filter = analyzer.char_filter.filter(cf => !allIcuFilterNames.includes(cf));
  }
  
  // Remove ICU token filter references
  if (analyzer.filter && Array.isArray(analyzer.filter)) {
    analyzer.filter = analyzer.filter.filter(f => !allIcuFilterNames.includes(f));
  }
});

// Output as JSON
console.log(JSON.stringify(indexDefinition, null, 2));
