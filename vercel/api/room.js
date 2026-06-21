const { handleRoomRequest } = require('../lib/room-handler');

module.exports = async function roomQueryHandler(req, res) {
  return handleRoomRequest(req, res, '');
};
