const streams = require('./stream/importPipeline');
const model = require('@mft/pelias-model');
const sink = require('through2-sink');
const fs = require('fs');

const limit = 100; // Change this to process more records
let count = 0;
const results = [];

console.log('Starting pipeline test (limit: ' + limit + ' records)...\n');

streams.pbfParser()
  .pipe(streams.docConstructor())
  .pipe(streams.tagMapper())
  .pipe(streams.addressExtractor())
  .pipe(streams.categoryMapper(streams.config.categoryDefaults))
  .pipe(streams.addendumMapper())
  .pipe(streams.popularityMapper())
  .pipe(model.createDocumentMapperStream())
  .pipe(sink.obj(function(doc) {
    if (count < limit) {
      results.push(doc);
      count++;
      if (count % 10 === 0) {
        console.log(`Processed ${count} records...`);
      }
    }
    if (count === limit) {
      count++; // Prevent re-entry
      console.log(`\nReached limit of ${limit} records. Writing output...\n`);
      
      fs.writeFileSync('uk-sample-output.json', JSON.stringify(results, null, 2));
      console.log('Output written to uk-sample-output.json');
      console.log('\nSample record:');
      console.log(JSON.stringify(results[0], null, 2));
      
      process.exit(0);
    }
  }))
  .on('error', (err) => {
    console.error('Pipeline error:', err);
    process.exit(1);
  })
  .on('finish', () => {
    console.log(`\nFinished. Total records: ${count}`);
  });
