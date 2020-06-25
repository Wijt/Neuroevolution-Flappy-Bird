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
    }

    feedForward(inputs){
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

    /*train(inputs, targets){
        let result = this.feedForward(inputs);
        let frontLayerError = [];
        for(let i = this.perceptrons.length-1; i >= 0; i--){
            let layerError = [];
        }
    }*/ // NO NEED to train function.
}