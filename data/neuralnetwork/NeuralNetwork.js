class NeuralNetwork {
    constructor(sizes) {//[2 2 1]
        this.sizes = sizes;
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
        let copy = new NeuralNetwork(this.sizes);
        let cPerceptrons = [];
        for (let i = 0; i < this.perceptrons.length; i++) {
            let layer=[];
            for (let j = 0; j < this.perceptrons[i].length; j++){
                layer.push(this.perceptrons[i][j].copy());
            }
            cPerceptrons.push(layer);
        }
        copy.perceptrons = cPerceptrons;
        return copy;
    }

    mutate(){
        for (let i = 0; i < this.perceptrons.length; i++) {
            for (let j = 0; j < this.perceptrons[i].length; j++){
                this.perceptrons[i][j].mutate(giveMutateRate(MUTATION_CHANCE));
            }
        }
    }

    serialize(){

    }

    static deserialize(jsonObject){
        console.log(jsonObject);
        let brain = new NeuralNetwork(jsonObject.sizes);
        let cPerceptrons = [];
        for (let i = 0; i < jsonObject.perceptrons.length; i++) {
            let layer=[];
            for (let j = 0; j < jsonObject.perceptrons[i].length; j++){
                layer.push(Object.assign(Perceptron.prototype, jsonObject.perceptrons[i][j]));
                //console.log(layer[j]);
            }
            cPerceptrons.push(layer);
        }
        brain.perceptrons = cPerceptrons;
        return brain;
    }
}