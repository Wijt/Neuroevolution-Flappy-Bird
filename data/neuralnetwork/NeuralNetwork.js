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
    
    copy(){
       return Object.assign({}, this);
    }

    mutate(){
        for (let i = 0; i < this.perceptrons.length; i++) {
            for (let j=0; j < this.perceptrons[i].length; j++){
                this.perceptrons[i][j].mutate(giveMutateRate(MUTATION_CHANCE));
            }
        }
    }
}