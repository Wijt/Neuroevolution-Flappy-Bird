class AIBird extends Bird {
    constructor(x, y, brain, inputs) {
        super(x, y);
        
        this.brain = brain || new NeuralNetwork([5,10,10,1]);
        this.fitness = 0;

        this.inputs = inputs;

        //this variable created to pervent repetetive score increment
        this.lastEarnedScoresPipe;
    } 

    think(){
        if (this.brain == null){
            console.error("Isn't a brain neccessary to think?");
            return;
        }

        if (this.inputs == null){
            console.error("There should be a thing to think!");
        }

        if (this.inputs.length != this.brain.sizes[0]){
            console.error(`Inputs array should be 1x${this.brain.sizes[0]}.`);
            return;
        }

        let result = this.brain.feedForward(this.inputs);

        if(result[0] > 0){
            this.jump();
        }
    }

    update() {
        super.update();

        if(!this.live) return;

        this.think();
        this.fitness += frameCount;
    }

}