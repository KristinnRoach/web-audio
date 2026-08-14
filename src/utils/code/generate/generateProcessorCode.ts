export function generateProcessorCode(
  { className, registryName }: { className: string; registryName: string },
  processFunc: Function,
  params: AudioParamDescriptor[],
  options: {
    state?: Record<string, unknown>;
    constructorCode?: Function;
    messageHandler?: Function;
  } = {}
): string {
  if (typeof processFunc !== 'function') {
    throw new Error('Process function must be a function');
  }

  const paramsJSON = JSON.stringify(params);

  let funcBody = processFunc.toString();
  funcBody = funcBody.substring(
    funcBody.indexOf('{') + 1,
    funcBody.lastIndexOf('}')
  );

  // State initialization for constructor
  const stateInit = options.state
    ? Object.entries(options.state)
        .map(([key, value]) => `this.${key} = ${JSON.stringify(value)};`)
        .join('\n          ')
    : '';

  const extraConstructorCode = options.constructorCode
    ? options.constructorCode
        .toString()
        .substring(
          options.constructorCode.toString().indexOf('{') + 1,
          options.constructorCode.toString().lastIndexOf('}')
        )
    : '';

  let messageHandler;
  if (options.messageHandler) {
    const handlerStr = options.messageHandler.toString();
    const handlerBody = handlerStr.substring(
      handlerStr.indexOf('{') + 1,
      handlerStr.lastIndexOf('}')
    );

    messageHandler = `this.port.onmessage = (event) => {
                if (event.data.hasOwnProperty('active')) {
                  this.active = event.data.active;
                }
                ${handlerBody}
              };`;
  } else {
    messageHandler = `this.port.onmessage = (event) => {
                if (event.data.hasOwnProperty('active')) {
                  this.active = event.data.active;
                }
              };`;
  }

  return `
        class ${className} extends AudioWorkletProcessor {
          static get parameterDescriptors() {
            return ${paramsJSON};
          }
  
          constructor() {
            super();
            this.active = true;
            ${stateInit}
            ${messageHandler}
            ${extraConstructorCode}
          }
  
          process(inputs, outputs, parameters) {
            if (!this.active) return true;
            ${funcBody}
          }
        }
  
        registerProcessor("${registryName}", ${className});
      `; // Note: double quotes are necessary for the registry name
}
