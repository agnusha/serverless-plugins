module.exports.promise = (event, context) => {
  console.log('lambda event promise', JSON.stringify(event));
  return Promise.resolve();
};

module.exports.callback = (event, context, cb) => {
  console.log('lambda event callback', JSON.stringify(event));
  cb();
};
