export class HubClientError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'HubClientError';
    this.code = code;
    this.status = status;
  }
}

