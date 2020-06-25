class Perceptron {
    constructor(inputCount) {
        this.weights = [];
        this.bias = 1;
        this.learingRate = PERCEPTRON_LEARING_RATE;

        for (let i = 0; i < inputCount+1; i++) {
            this.weights.push(random(-1,1));
        }
    }

    fire(inputs){
        let sum = 0;
        for (let i = 0; i < this.weights.length; i++) {
            if (i >= inputs.length)
                sum += this.bias * this.weights[i] // For the bias
            else
                sum += inputs[i] * this.weights[i]
        }
        return sum >= 0 ? sum : 0;           //ReLu function
    }
}