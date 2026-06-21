function mapQuality(quality) {
  if (!quality) {
    return null;
  }

  return {
    name: quality.name,
    sdkKey: quality.sdk_key,
    codec: quality.v_codec,
    resolution: quality.resolution,
    level: quality.level,
    bitRate: quality.v_bit_rate,
    fps: quality.fps,
    disabled: Boolean(quality.disable)
  };
}

function normalizeRoomStatusCode(roomStatus) {
  if (typeof roomStatus === 'number' && Number.isFinite(roomStatus)) {
    return roomStatus;
  }

  if (typeof roomStatus !== 'string') {
    return null;
  }

  switch (roomStatus.toLowerCase()) {
    case 'normal':
      return 0;
    case 'radio':
      return 1;
    case 'ended':
      return 2;
    default:
      return null;
  }
}

function normalizeRoomStatusText(roomStatus) {
  if (typeof roomStatus === 'string' && roomStatus) {
    return roomStatus;
  }

  switch (normalizeRoomStatusCode(roomStatus)) {
    case 0:
      return 'normal';
    case 1:
      return 'radio';
    case 2:
      return 'ended';
    default:
      return 'unknown';
  }
}

function hasPlayableStream(streamUrl) {
  return Boolean(
    streamUrl?.hls_pull_url ||
      Object.keys(streamUrl?.hls_pull_url_map || {}).length ||
      Object.keys(streamUrl?.flv_pull_url || {}).length
  );
}

function normalizeRoomAuth(roomAuth) {
  if (!roomAuth) {
    return {};
  }

  return {
    chat: roomAuth.Chat,
    danmaku: roomAuth.Danmaku,
    gift: roomAuth.Gift,
    digg: roomAuth.Digg,
    share: roomAuth.Share,
    castScreen: roomAuth.CastScreen,
    commentWall: roomAuth.CommentWall,
    fansClub: roomAuth.FansClub,
    commerceCard: roomAuth.CommerceCard,
    landscape: roomAuth.Landscape,
    landscapeChat: roomAuth.LandscapeChat,
    publicScreen: roomAuth.PublicScreen,
    recordScreen: roomAuth.RecordScreen,
    downloadVideo: roomAuth.DownloadVideo,
    multiplierPlayback: roomAuth.MultiplierPlayback,
    showGamePlugin: roomAuth.ShowGamePlugin,
    chatHint: roomAuth.SpecialStyle?.Chat?.Content || ''
  };
}

function normalizeRoom(payload, webRid, upstream) {
  if (!payload || payload.status_code !== 0) {
    const code = payload?.status_code;
    throw new Error(`Unexpected upstream payload status_code: ${code ?? 'unknown'}`);
  }

  const root = payload.data || {};
  const room = root.data?.[0] || {};
  const owner = room.owner || root.user || {};
  const streamUrl = room.stream_url || {};
  const streamOptions = streamUrl.live_core_sdk_data?.pull_data?.options || {};
  const roomViewStats = room.room_view_stats || {};
  const stats = room.stats || {};
  const partitionRoadMap = root.partition_road_map || {};
  const partition = partitionRoadMap.partition || {};
  const subPartition = partitionRoadMap.sub_partition?.partition || {};
  const gameTagInfo = room.game_data?.game_tag_info || {};

  return {
    ok: true,
    fetchedAt: new Date().toISOString(),
    upstream,
    room: {
      webRid: String(webRid),
      roomId: root.enter_room_id || room.id_str || '',
      title: room.title || '',
      status: {
        roomStatus: normalizeRoomStatusText(root.room_status),
        roomStatusCode: normalizeRoomStatusCode(root.room_status),
        liveStatus: room.status ?? null,
        mosaicStatus: room.mosaic_status ?? null,
        isLive: hasPlayableStream(streamUrl)
      },
      cover: {
        current: room.cover?.url_list?.[0] || '',
        urls: room.cover?.url_list || []
      },
      qrCodeUrl: root.qrcode_url || ''
    },
    owner: {
      id: owner.id_str || '',
      secUid: owner.sec_uid || '',
      nickname: owner.nickname || '',
      avatar: owner.avatar_thumb?.url_list?.[0] || '',
      avatars: owner.avatar_thumb?.url_list || []
    },
    viewerContext: {
      isLogin: Boolean(root.login_lead?.is_login),
      followStatus: owner.follow_info?.follow_status ?? null,
      subscribeOpen: owner.subscribe?.open ?? null,
      isMember: owner.subscribe?.is_member ?? null
    },
    stats: {
      viewers: roomViewStats.display_value ?? null,
      viewersText: roomViewStats.display_long || stats.user_count_str || room.user_count_str || '',
      viewersShort: roomViewStats.display_short || room.user_count_str || '',
      totalViewersText: stats.total_user_str || '',
      totalViewers: stats.total_user ?? null,
      likes: room.like_count ?? stats.like_count ?? null,
      commentCount: stats.comment_count ?? null,
      followCount: stats.follow_count ?? null,
      giftUvCount: stats.gift_uv_count ?? null,
      enterCount: stats.enter_count ?? null,
      popularity: room.popularity ?? null,
      popularityText: room.popularity_str ?? null,
      diggCount: stats.digg_count ?? null,
      fanTicket: stats.fan_ticket ?? null,
      money: stats.money ?? null,
      welfareDonationAmount: stats.welfare_donation_amount ?? null,
      userCountComposition: stats.user_count_composition ?? null,
      upRightStats: stats.up_right_stats_str ?? null,
      upRightStatsComplete: stats.up_right_stats_str_complete ?? null
    },
    time: {
      createTime: room.create_time ?? null,
      startTime: room.start_time ?? null,
      finishTime: room.finish_time ?? null
    },
    category: {
      partitionId: partition.id_str || '',
      partitionTitle: partition.title || '',
      subPartitionId: subPartition.id_str || '',
      subPartitionTitle: subPartition.title || '',
      gameTagId: gameTagInfo.game_tag_id ?? null,
      gameTagName: gameTagInfo.game_tag_name || '',
      isGame: Boolean(gameTagInfo.is_game)
    },
    stream: {
      orientation: streamUrl.stream_orientation ?? null,
      defaultResolution: streamUrl.default_resolution || '',
      defaultQuality: mapQuality(streamOptions.default_quality),
      qualities: (streamOptions.qualities || []).map(mapQuality).filter(Boolean),
      flv: {
        byQuality: streamUrl.flv_pull_url || {}
      },
      hls: {
        default: streamUrl.hls_pull_url || '',
        byQuality: streamUrl.hls_pull_url_map || {}
      }
    },
    permissions: normalizeRoomAuth(room.room_auth),
    interaction: {
      audiencePreApply: room.linker_detail?.accept_audience_pre_apply ?? null,
      audienceLinkmicEnabled: room.linker_detail?.enable_audience_linkmic ?? null,
      linkerUiLayout: room.linker_detail?.linker_ui_layout ?? null
    },
    commerce: {
      hasCommerceGoods: room.has_commerce_goods ?? null,
      containCart: room.room_cart?.contain_cart ?? null,
      cartTotal: room.room_cart?.total ?? null,
      paidType: room.paid_live_data?.paid_type ?? null,
      viewRight: room.paid_live_data?.view_right ?? null
    },
    meta: {
      enterMode: root.enter_mode ?? null,
      serverTimeMs: payload.extra?.now ?? null,
      proxyUsed: Boolean(upstream?.proxyUsed)
    }
  };
}

module.exports = {
  normalizeRoom
};
