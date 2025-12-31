// tmdb.cjs
// Minimal TMDb helpers for searching + details + providers + reviews + similar + discover.
const TMDB_BASE = "https://api.themoviedb.org/3";

async function tmdbGet(path, apiKey, params = {}) {
  const url = new URL(TMDB_BASE + path);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  });

  const res = await fetch(url.toString(), {
    headers: {
      // For simplicity we use a Bearer token style header.
      // If your TMDb key is a v4 access token, this works as-is.
      // If you only have a v3 API key, you can switch to ?api_key=... in tmdbGet.
      Authorization: `Bearer ${apiKey}`
    }
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`TMDb error ${res.status}: ${t}`);
  }
  return res.json();
}

async function searchMovie({ apiKey, query, year, language }) {
  return tmdbGet("/search/movie", apiKey, { query, year, language, include_adult: false });
}

async function movieDetails({ apiKey, movieId, language }) {
  return tmdbGet(`/movie/${movieId}`, apiKey, { language });
}

async function movieWatchProviders({ apiKey, movieId }) {
  return tmdbGet(`/movie/${movieId}/watch/providers`, apiKey, {});
}

async function movieReviews({ apiKey, movieId, language }) {
  return tmdbGet(`/movie/${movieId}/reviews`, apiKey, { language, page: 1 });
}

async function movieSimilar({ apiKey, movieId, language, page = 1 }) {
  return tmdbGet(`/movie/${movieId}/similar`, apiKey, { language, page });
}

async function discoverMovies({ apiKey, language, region, with_genres, page = 1, sort_by }) {
  return tmdbGet("/discover/movie", apiKey, {
    language,
    region,
    with_genres,
    page,
    sort_by: sort_by || "vote_count.desc",
    include_adult: false
  });
}

module.exports = {
  searchMovie,
  movieDetails,
  movieWatchProviders,
  movieReviews,
  movieSimilar,
  discoverMovies
};
