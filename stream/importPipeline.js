var categoryDefaults = require('../config/category_map');

var streams = {};

streams.config = {
  categoryDefaults: categoryDefaults
};

streams.pbfParser = require('./multiple_pbfs').create;
streams.docConstructor = require('./document_constructor');
streams.blacklistStream = require('pelias-blacklist-stream');
streams.tagMapper = require('./tag_mapper');
streams.addressesWithoutStreet = require('./addresses_without_street');
streams.adminLookup = require('pelias-wof-admin-lookup').create;
streams.addressExtractor = require('./address_extractor');
streams.postcodeEnricher = require('./postcodeEnricher');
streams.categoryMapper = require('./category_mapper');
streams.addendumMapper = require('./addendum_mapper');
streams.popularityMapper = require('./popularity_mapper');
streams.dbMapper = require('@mft/pelias-model').createDocumentMapperStream;
streams.elasticsearch = require('pelias-dbclient');

// default import pipeline
streams.import = function(){
  const peliasConfig = require('pelias-config').generate();
  // Default to true for backward compatibility
  const enablePostcodeEnrichment = peliasConfig.imports?.openstreetmap?.enablePostcodeEnrichment !== false;
  
  console.log('[importPipeline] Postcode enrichment enabled:', enablePostcodeEnrichment);
  console.log('[importPipeline] Config value:', peliasConfig.imports?.openstreetmap?.enablePostcodeEnrichment);
  
  var pipeline = streams.pbfParser()
    .pipe( streams.docConstructor() )
    .pipe( streams.addressesWithoutStreet() )
    .pipe( streams.tagMapper() )
    .pipe( streams.addressExtractor() );
  
  // Conditionally add postcode enricher
  if (enablePostcodeEnrichment) {
    console.log('[importPipeline] Adding postcode enricher to pipeline');
    pipeline = pipeline.pipe( streams.postcodeEnricher() );
  } else {
    console.log('[importPipeline] Skipping postcode enricher (baseline mode)');
  }
  
  return pipeline
    .pipe( streams.blacklistStream() )
    .pipe( streams.categoryMapper( categoryDefaults ) )
    .pipe( streams.addendumMapper() )
    .pipe( streams.popularityMapper() )
    .pipe( streams.adminLookup() )
    .pipe( streams.dbMapper() )
    .pipe( streams.elasticsearch({name: 'openstreetmap'}) );
};

module.exports = streams;
