class NeuralNetwork {
    constructor(sizes) {//[2 2 1]
        this.perceptrons=[];
        for (let i = 1; i < sizes.length; i++) {
            let layer=[];
            for (let j = 0; j < sizes[i]; j++){
                layer.push(new Perceptron(sizes[i-1]));
            }
            this.perceptrons.push(layer);
        }
        //console.table(this.perceptrons);
        /*this.size = {input: inputC, hidden: hiddenC, output: outputC};
        this.perceptrons = [];
        this.hiddenP = [];
        this.outputP = [];
        for (let i = 0; i < hiddenC; i++) {
            let p = new Perceptron(inputC); //+1 for the bias
            this.hiddenP.push(p);       
        }
        for (let i = 0; i < outputC; i++) {
            let p = new Perceptron(hiddenC); //+1 for the bias
            this.outputP.push(p);
        }
        this.perceptrons.push(this.hiddenP);
        this.perceptrons.push(this.outputP);*/
    }

    feedForward(inputs){
        /*let hiddenOutputs = [];
        let returnV = [];
        for (let i = 0; i < this.size.hidden; i++) {
            hiddenOutputs.push(this.perceptrons[0][i].fire(inputs));
        }
        for (let i = 0; i < this.size.output; i++) {
            returnV.push(this.perceptrons[1][i].fire(hiddenOutputs));
        }
        return returnV;*/
        let previousOutputs = inputs;
        for (let i = 0; i < this.perceptrons.length; i++) {
            let layerOutput = [];
            for (let j=0; j < this.perceptrons[i].length; j++){
                let output = this.perceptrons[i][j].fire(previousOutputs);
                layerOutput.push(output);
            }
            previousOutputs = layerOutput;
        }
        return previousOutputs;
    }

    train(inputs, targets){
        /*
        let result = this.feedForward(inputs);
        //let error = targets - result;
        let error = [];
        for (let i = 0; i < this.size.output; i++) {
            error.push(targets[i] - result[i]);
        }
        for (let i = 0; i < this.perceptrons[1].length; i++) {
            
        }
        console.table(inputs);
        console.table(targets);
        console.table(result);
        console.table(error);*/
        let result = this.feedForward(inputs);
        let frontLayerError = [];
        for(let i = this.perceptrons.length-1; i >= 0; i--){
            let layerError = [];
        }
    }
}