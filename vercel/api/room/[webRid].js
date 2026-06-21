const { handleRoomRequest } = require('../../lib/room-handler');

module.exports = async function roomPathHandler(req, res) {
  return handleRoomRequest(req, res, req.query.webRid || '');
};
