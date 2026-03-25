/**
 * Operations response translators.
 *
 * Operations routes reuse the same daemon-to-gateway error translation rules as
 * the conversation transport until operations-specific mappings are needed.
 */
export {
  translateDaemonResponse as translateOperationsDaemonResponse,
  translateFetchFailure as translateOperationsFetchFailure,
} from '../conversation/response-translator.ts';
