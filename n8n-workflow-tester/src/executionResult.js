class NodeResult {
  constructor(runDatum) {
    this._d = runDatum || null;
  }
  get executionStatus() {
    return this._d?.executionStatus || (this._d?.error ? 'error' : undefined);
  }
  get errorMessage() {
    return this._d?.error?.message;
  }

  getData(index) {
    const items = this._d?.data?.main?.[index]?.[0];
    return items?.json ?? undefined;
  }

  get data() {
    return this.getData(0);
  }
}

class ExecutionResult {
  constructor(parsedCliObject) {
    this.raw = parsedCliObject;
    this._runData = parsedCliObject?.data?.resultData?.runData || {};
    this._topError = parsedCliObject?.data?.resultData?.error || parsedCliObject?.error || null;
  }

  printWorkflow() {
    console.dir(this, { depth: null }); 
  }

  get executionStatus() {
    return this._topError ? 'error' : 'success';
  }

  get errorMessage() {
    return this._topError?.message || null;
  }

  node(name) {
    const arr = this._runData?.[name];
    if (!arr || !arr.length) return new NodeResult(null);
    return new NodeResult(arr[0]);
  }

  get lastNodeExecuted() {
    return this.raw?.data?.resultData?.lastNodeExecuted;
  }
}

module.exports = { ExecutionResult, NodeResult };
