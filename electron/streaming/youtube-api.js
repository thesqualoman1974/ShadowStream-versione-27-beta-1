'use strict';

async function youtubeApiRequest(url, accessToken, fetchImpl = fetch) {
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`Richiesta YouTube Data API non riuscita (HTTP ${response.status}).`);
  }
  const body = await response.json();
  if (!body || typeof body !== 'object') {
    throw new Error('Risposta YouTube Data API non valida.');
  }
  return body;
}

async function listYoutubeStreams(accessToken, fetchImpl = fetch) {
  const url = new URL('https://www.googleapis.com/youtube/v3/liveStreams');
  url.searchParams.set('part', 'id,snippet,status');
  url.searchParams.set('mine', 'true');
  url.searchParams.set('maxResults', '50');
  const result = await youtubeApiRequest(url, accessToken, fetchImpl);
  if (!Array.isArray(result.items)) throw new Error('Elenco live YouTube non valido.');
  return result.items.flatMap((item) => {
    if (typeof item?.id !== 'string' || typeof item?.snippet?.title !== 'string') return [];
    return [{
      id: item.id,
      title: item.snippet.title,
      status: typeof item.status?.streamStatus === 'string' ? item.status.streamStatus : 'unknown',
    }];
  });
}

async function getYoutubeStreamIngest(accessToken, streamId, fetchImpl = fetch) {
  if (typeof streamId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(streamId)) {
    throw new TypeError('ID stream YouTube non valido.');
  }
  const url = new URL('https://www.googleapis.com/youtube/v3/liveStreams');
  url.searchParams.set('part', 'cdn');
  url.searchParams.set('id', streamId);
  const result = await youtubeApiRequest(url, accessToken, fetchImpl);
  const stream = result.items?.find((item) => item?.id === streamId);
  const ingestionInfo = stream?.cdn?.ingestionInfo;
  if (typeof ingestionInfo?.ingestionAddress !== 'string'
    || typeof ingestionInfo?.streamName !== 'string'
    || !ingestionInfo.streamName) {
    throw new Error('YouTube non ha restituito un server e una chiave per questo live stream.');
  }
  return {
    server: ingestionInfo.ingestionAddress,
    key: ingestionInfo.streamName,
  };
}

module.exports = { getYoutubeStreamIngest, listYoutubeStreams, youtubeApiRequest };
