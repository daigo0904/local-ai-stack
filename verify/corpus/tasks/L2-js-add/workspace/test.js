const { add } = require('./sum.js');
process.exit(add('1', '2') === 3 ? 0 : 1);
