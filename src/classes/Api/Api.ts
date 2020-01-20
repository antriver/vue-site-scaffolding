import axios, { AxiosInstance, Method } from 'axios';
import qs from 'qs';
import cloneDeep from 'lodash/cloneDeep';
import { AbstractApi } from './AbstractApi';
import { ApiError } from './ApiError';

const logApiError = (err: ApiError) => {
    /* global Raven */
    if (typeof Raven !== 'undefined') {
        const responseStatus = err.response ? parseInt(err.response.status) : null;
        if (responseStatus === 403) {
            return;
        }
        if (err.message === 'Network Error') {
            return;
        }
        Raven.captureException(
            err,
            {
                level: 'error',
                extra: {
                    method: err.request.method,
                    url: err.request.url,
                    params: err.request.params,
                    headers: err.request.headers,
                    response: err.response
                }
            }
        );
    }
};

export class Api extends AbstractApi {
    protected axios: AxiosInstance;

    constructor(apiUrl: string, authToken: string|null, headers: any) {
        super(apiUrl, authToken);
        this.headers = headers;
        this.axios = axios.create();
    }

    request(method: Method, endpoint: string, data: object, cache?: boolean): Promise<any> {
        const startedAt = Date.now();

        let url = this.createUrl(endpoint);

        let params: any;
        if (data) {
            // Copy data to a new object so we don't accidentally modify the original during SSR.
            params = {
                ...data
            };
        } else {
            params = {};
        }

        cache = method === 'GET' && cache === true;

        const headers = { ...this.headers };

        if (method !== 'GET') {
            // headers['content-type'] = 'application/x-www-form-urlencoded';

            if (method !== 'POST') {
                // Spoof PATCH and DELETE
                params._method = method; // eslint-disable-line no-underscore-dangle
                method = 'POST';
            }
        }

        if (this.authToken && !params.token) {
            if (method === 'GET') {
                params.token = this.authToken;
            } else {
                url += `?token=${this.authToken}`;
            }
        }

        const jsonParams = JSON.stringify(params);

        let cacheKey: string;
        if (cache === true) {
            cacheKey = url + jsonParams;
        }

        return new Promise((resolve, reject) => {
            /**
             * @param {object} response
             * @param {boolean} [fromCache]
             */
            const onSuccess = (response: any, fromCache: boolean) => {
                if (response.error) {
                    // Handle cases where the server returns an error response with a 200 status.
                    onError(response.error, response);
                    return;
                }

                // Store in the cache.
                if (!fromCache && cache === true && this.cache) {
                    this.cache.set(cacheKey, response);
                }

                resolve(response);
            };

            /**
             * @param {string} message
             * @param {?object} response
             */
            let onError = (message: string, response: any) => {
                if (!response) {
                    // response will always be an object to avoid having to check everywhere.
                    response = {};
                }

                console.error('[API] Error', method, url, jsonParams, message, response);

                const err = new ApiError(message, response, {
                    method, url, params, headers
                });
                logApiError(err);

                // if (error === true) {
                //     // Set the error callback to boolean true to use the default error handler.
                //     showAlert(message);
                // }

                reject(err);
            };

            const onComplete = () => {
                console.log(`[API] Request took ${Date.now() - startedAt}ms`, method, url, jsonParams);
            };

            // Check the cache for an existing result.
            if (cache === true && this.cache) {
                // Check for a cached copy of this request.
                const cachedResult = this.cache.get(cacheKey);
                if (cachedResult) {
                    console.log('[API] Cached Result', method, url);
                    onSuccess(cloneDeep(cachedResult), true);
                    onComplete();
                    return;
                }
            }

            console.log('[API] Request', method, url); // , jsonParams, headers);

            this.axios.request({
                method,
                url,
                headers,
                timeout: 20000, // 20 seconds

                // If data is an object it will be sent as application/json.
                // So we convert it to a string and it is sent as application/x-www-form-urlencoded
                data: method !== 'GET' ? qs.stringify(params) : null,
                // data: method !== 'GET' ? params : null,

                // `params` are the URL parameters (query string) to be sent with the request
                // Must be a plain object or a URLSearchParams object
                params: method === 'GET' ? params : {},

                responseType: 'json'
            })
                .then((response) => {
                    if (response && typeof response.data === 'object' && response.data) {
                        onSuccess(response.data, false);
                    } else {
                        onError('Unexpected API response.', response.data);
                    }
                })
                .catch((err) => {
                    let message;
                    let responseJson;

                    if (err) {
                        if (err.response && err.response.data) {
                            responseJson = err.response.data;
                        }

                        if (responseJson && responseJson.hasOwnProperty('error')) {
                            message = responseJson.error;
                        } else {
                            message = err.message ? err.message : err.toString();
                        }
                    }

                    if (!message) {
                        message = 'API Error';
                    }

                    onError(message, responseJson);
                })
                .finally(onComplete);
        });
    }
}
